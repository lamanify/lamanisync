// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KillSwitchCoordinator } from '../../src/background/kill-switch.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';

describe('Remote Kill-Switch Coordinator (Phase 10)', () => {
  let fsm: ConnectionFSM;
  let coordinator: KillSwitchCoordinator;
  let pauseCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fsm = new ConnectionFSM({ state: 'ACTIVE' });
    pauseCallback = vi.fn();
    coordinator = new KillSwitchCoordinator({
      fsm,
      onPauseTriggered: pauseCallback,
    });
  });

  describe('Global Kill-Switch', () => {
    it('pauses globally and transitions FSM to PAUSED', () => {
      expect(coordinator.isPaused()).toBe(false);

      coordinator.triggerPause('global', undefined, 'Emergency maintenance');

      expect(coordinator.isGlobalPaused()).toBe(true);
      expect(coordinator.isPaused()).toBe(true);
      expect(coordinator.getPauseReason()).toContain('Emergency maintenance');
      expect(pauseCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'global',
          reason: 'Emergency maintenance',
        })
      );
      expect(fsm.getState()).toBe('PAUSED');
    });

    it('resumes from global pause back to ACTIVE', () => {
      coordinator.triggerPause('global', undefined, 'Emergency');
      expect(fsm.getState()).toBe('PAUSED');

      coordinator.resume('global');
      expect(coordinator.isGlobalPaused()).toBe(false);
      expect(coordinator.isPaused()).toBe(false);
      expect(fsm.getState()).toBe('ACTIVE');
    });
  });

  describe('Adapter-Level Kill-Switch', () => {
    it('pauses specific adapter without affecting other adapters', () => {
      coordinator.triggerPause('adapter', 'acme-cloud-v1', 'Adapter revoked');

      expect(coordinator.isAdapterPaused('acme-cloud-v1')).toBe(true);
      expect(coordinator.isAdapterPaused('other-adapter-v2')).toBe(false);

      // Checking with target adapter
      expect(coordinator.isPaused({ adapterId: 'acme-cloud-v1' })).toBe(true);
      expect(coordinator.getPauseReason({ adapterId: 'acme-cloud-v1' })).toBe('Adapter revoked');

      // Unrelated adapter is not paused if FSM not paused (wait, triggerPause transitions FSM to PAUSED)
      // When adapter pause is resumed:
      coordinator.resume('adapter', 'acme-cloud-v1');
      expect(coordinator.isAdapterPaused('acme-cloud-v1')).toBe(false);
      expect(fsm.getState()).toBe('ACTIVE');
    });
  });

  describe('Connection-Level Kill-Switch', () => {
    it('pauses specific connection without affecting other connections', () => {
      coordinator.triggerPause('connection', 'conn_clinic_1', 'Tenant disabled');

      expect(coordinator.isConnectionPaused('conn_clinic_1')).toBe(true);
      expect(coordinator.isConnectionPaused('conn_clinic_2')).toBe(false);
      expect(coordinator.isPaused({ connectionId: 'conn_clinic_1' })).toBe(true);

      coordinator.resume('connection', 'conn_clinic_1');
      expect(coordinator.isConnectionPaused('conn_clinic_1')).toBe(false);
      expect(fsm.getState()).toBe('ACTIVE');
    });
  });

  describe('processRemoteSignal', () => {
    it('parses remote signal with status: PAUSED and level: adapter', () => {
      const handled = coordinator.processRemoteSignal({
        status: 'PAUSED',
        killSwitchLevel: 'adapter',
        targetId: 'acme-cloud-v1',
        message: 'Security update required',
      });

      expect(handled).toBe(true);
      expect(coordinator.isAdapterPaused('acme-cloud-v1')).toBe(true);
      expect(fsm.getState()).toBe('PAUSED');
      expect(pauseCallback).toHaveBeenCalled();
    });

    it('parses remote signal with error: PAUSED at connection level', () => {
      const handled = coordinator.processRemoteSignal({
        error: 'PAUSED',
        killSwitchLevel: 'connection',
        targetId: 'conn_123',
        message: 'Subscription expired',
      });

      expect(handled).toBe(true);
      expect(coordinator.isConnectionPaused('conn_123')).toBe(true);
      expect(fsm.getState()).toBe('PAUSED');
    });

    it('returns false for normal responses without pause indicator', () => {
      const handled = coordinator.processRemoteSignal({
        status: 'ok',
        acknowledged: true,
      });

      expect(handled).toBe(false);
      expect(coordinator.isPaused()).toBe(false);
      expect(fsm.getState()).toBe('ACTIVE');
    });
  });
});
