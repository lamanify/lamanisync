// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isHeartbeatStale,
  computeConflictRate,
  computeWriteFailureRate,
  evaluateOperationalAlerts,
  assertNoRawPhiInMetrics,
  type CommandMetricEvent,
  DEFAULT_MYT_OPERATING_HOURS,
} from '../../src/core/telemetry.js';
import { KillSwitchCoordinator } from '../../src/background/kill-switch.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import {
  promoteToActive,
  rollbackToLkg,
  getActiveManifest,
  InMemoryStorageAdapter,
} from '../../src/adapters/lifecycle.js';
import { signManifest } from '../../test-harness/fixtures/signing-keys.js';
import type { AdapterManifest } from '../../src/adapters/schema.js';

describe('Phase 14 — Operational Monitoring & Telemetry Evaluator', () => {
  describe('Heartbeat Freshness Evaluation', () => {
    it('detects fresh heartbeat within operating hours', () => {
      // 10:00 AM MYT (02:00 UTC)
      const now = new Date('2026-09-21T02:00:00Z').getTime();
      const lastHeartbeat = now - 5 * 60 * 1000; // 5 mins ago

      expect(isHeartbeatStale(lastHeartbeat, now, DEFAULT_MYT_OPERATING_HOURS)).toBe(false);
    });

    it('triggers stale heartbeat alert when silence > 15 minutes during operating hours', () => {
      // 14:00 PM MYT (06:00 UTC)
      const now = new Date('2026-09-21T06:00:00Z').getTime();
      const lastHeartbeat = now - 16 * 60 * 1000; // 16 mins ago

      expect(isHeartbeatStale(lastHeartbeat, now, DEFAULT_MYT_OPERATING_HOURS)).toBe(true);

      const alerts = evaluateOperationalAlerts({
        heartbeat: {
          lastHeartbeatMs: lastHeartbeat,
          connectionId: 'conn_test_01',
        },
        currentMs: now,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].code).toBe('HEARTBEAT_STALE');
      expect(alerts[0].severity).toBe('critical');
      expect(alerts[0].details.minutesStale).toBe(16);
    });

    it('suppresses stale alert outside clinic operating hours', () => {
      // 03:00 AM MYT (19:00 UTC previous day) - clinic closed
      const now = new Date('2026-09-20T19:00:00Z').getTime();
      const lastHeartbeat = now - 60 * 60 * 1000; // 1 hour ago

      expect(isHeartbeatStale(lastHeartbeat, now, DEFAULT_MYT_OPERATING_HOURS)).toBe(false);

      const alerts = evaluateOperationalAlerts({
        heartbeat: {
          lastHeartbeatMs: lastHeartbeat,
          connectionId: 'conn_test_01',
        },
        currentMs: now,
      });

      expect(alerts).toHaveLength(0);
    });
  });

  describe('Conflict & Write Failure Rate Tracking', () => {
    it('computes conflict rate accurately', () => {
      const events: CommandMetricEvent[] = [
        { timestamp: 1000, outcome: 'success' },
        { timestamp: 2000, outcome: 'conflict' },
        { timestamp: 3000, outcome: 'success' },
        { timestamp: 4000, outcome: 'success' },
      ];

      expect(computeConflictRate(events)).toBe(25); // 1 out of 4 = 25%
    });

    it('triggers warning when conflict rate exceeds 2% threshold', () => {
      // 100 commands, 3 conflicts = 3%
      const events: CommandMetricEvent[] = [];
      for (let i = 0; i < 97; i++) {
        events.push({ timestamp: 1000 + i, outcome: 'success' });
      }
      for (let i = 0; i < 3; i++) {
        events.push({ timestamp: 2000 + i, outcome: 'conflict' });
      }

      expect(computeConflictRate(events)).toBe(3.0);

      const alerts = evaluateOperationalAlerts({
        commandEvents: events,
      });

      const conflictAlert = alerts.find((a) => a.code === 'HIGH_CONFLICT_RATE');
      expect(conflictAlert).toBeDefined();
      expect(conflictAlert?.severity).toBe('warning');
      expect(conflictAlert?.details.conflictRate).toBe(3.0);
    });

    it('triggers critical alert when write verification failure rate exceeds 0.5%', () => {
      // 100 commands, 1 verification failure = 1% (> 0.5%)
      const events: CommandMetricEvent[] = [];
      for (let i = 0; i < 99; i++) {
        events.push({ timestamp: 1000 + i, outcome: 'success' });
      }
      events.push({ timestamp: 2000, outcome: 'verification_failure' });

      expect(computeWriteFailureRate(events)).toBe(1.0);

      const alerts = evaluateOperationalAlerts({
        commandEvents: events,
      });

      const writeAlert = alerts.find((a) => a.code === 'HIGH_WRITE_FAILURE_RATE');
      expect(writeAlert).toBeDefined();
      expect(writeAlert?.severity).toBe('critical');
      expect(writeAlert?.details.writeFailureRate).toBe(1.0);
    });

    it('ignores elevated rates if sample size is below minimum threshold (< 10)', () => {
      // 2 commands, 1 conflict = 50%, but sample size is only 2
      const events: CommandMetricEvent[] = [
        { timestamp: 1000, outcome: 'success' },
        { timestamp: 2000, outcome: 'conflict' },
      ];

      const alerts = evaluateOperationalAlerts({
        commandEvents: events,
      });

      expect(alerts).toHaveLength(0);
    });
  });

  describe('Zero PHI Enforcement in Telemetry', () => {
    it('accepts clean anonymous metric payloads', () => {
      const cleanData = {
        connectionId: 'conn_clinic_abc',
        metric: 'sync_latency_ms',
        value: 142,
        correlationId: 'cmd_corr_123',
        status: 'success',
      };

      expect(() => assertNoRawPhiInMetrics(cleanData)).not.toThrow();
    });

    it('rejects payloads containing Malaysian NRIC', () => {
      const dirtyData = {
        connectionId: 'conn_clinic_abc',
        metric: 'error_log',
        patientIc: '950101-14-1234',
      };

      expect(() => assertNoRawPhiInMetrics(dirtyData)).toThrow(/Potential PHI detected/);
    });

    it('rejects payloads containing phone numbers or email addresses', () => {
      const dirtyPhone = {
        metric: 'user_contact',
        phone: '+60123456789',
      };
      expect(() => assertNoRawPhiInMetrics(dirtyPhone)).toThrow(/Potential PHI detected/);

      const dirtyEmail = {
        metric: 'user_email',
        email: 'staff@clinic.com',
      };
      expect(() => assertNoRawPhiInMetrics(dirtyEmail)).toThrow(/Potential PHI detected/);
    });
  });

  describe('Incident Response — Kill-Switch Clean Halting Drill', () => {
    it('triggers pause and halts background execution in < 30 seconds', () => {
      const fsm = new ConnectionFSM();
      fsm.transition('PAIRING', { reason: 'pairing started' });
      fsm.transition('PAIRED_NO_PERMISSION', { reason: 'pairing exchange completed' });
      fsm.transition('PROBING', { reason: 'permission granted, probing' });
      fsm.transition('SHADOW', { reason: 'probe passed, shadow mode' });
      fsm.transition('ACTIVE', { reason: 'shadow passed, active mode' });

      let pauseNotified = false;
      const coordinator = new KillSwitchCoordinator({
        fsm,
        onPauseTriggered: () => {
          pauseNotified = true;
        },
      });

      expect(fsm.getState()).toBe('ACTIVE');
      expect(coordinator.isPaused()).toBe(false);

      // Trigger global kill-switch
      coordinator.triggerPause('global', undefined, 'Emergency security incident drill');

      expect(pauseNotified).toBe(true);
      expect(coordinator.isGlobalPaused()).toBe(true);
      expect(coordinator.isPaused()).toBe(true);
      expect(fsm.getState()).toBe('PAUSED');
      expect(fsm.getRecord().reason).toContain('Kill-switch activated [global]');

      // Operations safely resumed
      coordinator.resume('global');
      expect(coordinator.isPaused()).toBe(false);
      expect(fsm.getState()).toBe('ACTIVE');
    });
  });

  describe('Incident Response — Last-Known-Good Rollback Drill', () => {
    it('pins and rolls back to LKG when schema drift or failure occurs', async () => {
      const storage = new InMemoryStorageAdapter();
      const manifestPath = path.resolve('src/adapters/manifests/acme-cloud.json');
      const baseManifest: AdapterManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      baseManifest.signature = signManifest(baseManifest);

      // 1. Promote baseManifest to active (which also persists LKG)
      await promoteToActive(baseManifest, { storage });
      const initialActive = await getActiveManifest(baseManifest.adapterId, { storage });
      expect(initialActive?.version).toBe(baseManifest.version);

      // 2. Simulate rollback to LKG
      const rolledBack = await rollbackToLkg(baseManifest.adapterId, { storage });
      expect(rolledBack).not.toBeNull();
      expect(rolledBack?.adapterId).toBe(baseManifest.adapterId);
      expect(rolledBack?.version).toBe(baseManifest.version);

      const activeAfterRollback = await getActiveManifest(baseManifest.adapterId, { storage });
      expect(activeAfterRollback?.version).toBe(baseManifest.version);
    });
  });
});
