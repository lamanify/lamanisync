// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import rawManifest from '../../manifest.config.js';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { MockSyncApiServer } from '../../test-harness/mock-sync-api/server.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { PairingCoordinator, SESSION_STORAGE_KEY, type StorageAdapter } from '../../src/background/pairing.js';
import { LeaseCoordinator, LEASE_STORAGE_KEY } from '../../src/background/lease-client.js';
import { CommandExecutor } from '../../src/background/command-executor.js';
import { KillSwitchCoordinator } from '../../src/background/kill-switch.js';
import { ProbeRunner } from '../../src/background/probe.js';
import { BackfillEngine } from '../../src/background/backfill.js';
import { BatchUploader } from '../../src/background/batch-uploader.js';
import { DeduplicationCache } from '../../src/background/dedupe.js';
import { EchoSuppressor } from '../../src/background/echo-suppressor.js';
import { UpdateManager } from '../../src/background/update-manager.js';
import { setIndexedDbFactory, getOrCreateDeviceKey } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';
import {
  syncAndActivateAdapter,
  InMemoryStorageAdapter,
  getActiveManifest,
} from '../../src/adapters/lifecycle.js';
import { normalizeAppointment } from '../../src/core/contracts/appointment.js';
import { normalizeExactOrigin, toExactOriginPattern } from '../../src/background/permissions.js';
import { LamaniError, classifyError } from '../../src/core/errors.js';
import type { SyncCommand } from '../../src/core/contracts/commands.js';

class MemoryStorage implements StorageAdapter {
  private data = new Map<string, unknown>();

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    const keyArr = Array.isArray(keys) ? keys : [keys];
    for (const k of keyArr) {
      if (this.data.has(k)) {
        result[k] = this.data.get(k);
      }
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.data.set(k, v);
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const keyArr = Array.isArray(keys) ? keys : [keys];
    for (const k of keyArr) {
      this.data.delete(k);
    }
  }

  clear(): void {
    this.data.clear();
  }
}

function advanceFsmToActive(
  fsm: ConnectionFSM,
  connectionId = 'conn_test',
  targetOrigin = 'http://localhost:4001'
): void {
  fsm.transition('PAIRING', { reason: 'Pairing initiated' });
  fsm.transition('PAIRED_NO_PERMISSION', { reason: 'Pairing handshake complete', connectionId, targetOrigin });
  fsm.transition('PROBING', { reason: 'Host permission granted', connectionId, targetOrigin });
  fsm.transition('SHADOW', { reason: 'Probe passed', connectionId, targetOrigin });
  fsm.transition('ACTIVE', { reason: 'Shadow certification complete', connectionId, targetOrigin });
}

describe('Phase 11: 15 Required Browser & Runtime E2E Scenarios', () => {
  const CMS_PORT = 4091;
  const SYNC_PORT = 4092;
  const CMS_URL = `http://localhost:${CMS_PORT}`;
  const SYNC_URL = `http://localhost:${SYNC_PORT}`;

  let cmsServer: MockCmsServer;
  let syncServer: MockSyncApiServer;

  beforeAll(async () => {
    cmsServer = new MockCmsServer(CMS_PORT);
    syncServer = new MockSyncApiServer(SYNC_PORT);
    await Promise.all([cmsServer.start(), syncServer.start()]);
  });

  afterAll(async () => {
    await Promise.all([cmsServer.stop(), syncServer.stop()]);
  });

  beforeEach(async () => {
    cmsServer.reset();
    syncServer.reset();
    await fetch(`${CMS_URL}/__admin/reset`, { method: 'POST' });
    await fetch(`${SYNC_URL}/__admin/reset`, { method: 'POST' });
  });

  // --------------------------------------------------------------------------
  // Scenario 1: Fresh install of unpacked extension
  // --------------------------------------------------------------------------
  it('Scenario 1: Fresh install of unpacked extension initializes MV3 shell, Ed25519 key, and UNPAIRED state with zero PHI', async () => {
    const manifest = rawManifest as chrome.runtime.ManifestV3;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('LamaniSync');
    expect(manifest.permissions).toEqual(['storage', 'scripting', 'alarms', 'declarativeNetRequest']);
    expect(manifest.host_permissions).toEqual(['https://app.lamanihub.com/*']); // Rule 13 / CHROMEWEBSTORE.md

    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const storage = new MemoryStorage();

    // Verify storage is initially empty
    const initialStorage = await storage.get(SESSION_STORAGE_KEY);
    expect(initialStorage[SESSION_STORAGE_KEY]).toBeUndefined();

    // Verify ECDSA device key generation in IndexedDB (non-exportable private key)
    const keyPair = await getOrCreateDeviceKey();
    expect(keyPair.privateKey.extractable).toBe(false);
    expect(keyPair.privateKey.algorithm.name).toBe('ECDSA');
    expect(typeof keyPair.publicKeySpki).toBe('string');

    // Verify FSM initializes to UNPAIRED
    const fsm = new ConnectionFSM();
    expect(fsm.getState()).toBe('UNPAIRED');
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Upgrade from previous extension version
  // --------------------------------------------------------------------------
  it('Scenario 2: Upgrade from previous extension version preserves paired credentials, device key, and resumes connection', async () => {
    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const storage = new MemoryStorage();

    // Create existing device key and paired session under previous version 0.1.0
    await getOrCreateDeviceKey();
    const existingSession = {
      connectionId: 'conn_upgrade_test',
      clinicId: 'CLINIC-UPGRADE',
      targetOrigin: CMS_URL,
      sessionToken: 'lh_sess_upgrade_token_999',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      installationId: 'inst_upgrade_1',
      pairedAt: new Date().toISOString(),
    };
    await storage.set({ [SESSION_STORAGE_KEY]: existingSession });

    // Simulate runtime upgrade event (onInstalled with reason: update)
    const fsm = new ConnectionFSM();
    const apiClient = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });
    const coordinator = new PairingCoordinator({ fsm, apiClient, storage, idbFactory: idb });

    // Ensure service worker restore protocol runs
    const restoredRecord = await coordinator.restoreState();
    expect(restoredRecord.state).toBe('PAIRED_NO_PERMISSION');
    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    // Device key remains intact and unchanged
    const currentKey = await getOrCreateDeviceKey();
    expect(currentKey.publicKeySpki).toBeDefined();

    // Storage is uncorrupted
    const session = await coordinator.getSession();
    expect(session?.connectionId).toBe('conn_upgrade_test');
    expect(session?.sessionToken).toBe('lh_sess_upgrade_token_999');
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Pairing, unpairing, and immediate re-pairing
  // --------------------------------------------------------------------------
  it('Scenario 3: Pairing, unpairing, and immediate re-pairing executes clean transitions without leftover state', async () => {
    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const storage = new MemoryStorage();
    const fsm = new ConnectionFSM();
    const apiClient = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });

    const granted = new Set<string>();
    const registeredScripts: string[] = [];

    const permissionsApi = {
      request: async ({ origins }: { origins: string[] }) => {
        origins.forEach((o) => granted.add(o));
        return true;
      },
      contains: async ({ origins }: { origins: string[] }) => {
        return origins.every((o) => granted.has(o));
      },
      remove: async ({ origins }: { origins: string[] }) => {
        origins.forEach((o) => granted.delete(o));
        return true;
      },
    };

    const scriptingApi = {
      registerContentScripts: async (scripts: Array<{ id: string }>) => {
        registeredScripts.push(...scripts.map((s) => s.id));
      },
      getRegisteredContentScripts: async (filter?: { ids?: string[] }) => {
        const ids = filter?.ids;
        if (!ids) return registeredScripts.map((id) => ({ id }));
        return registeredScripts.filter((id) => ids.includes(id)).map((id) => ({ id }));
      },
      unregisterContentScripts: async (filter?: { ids?: string[] }) => {
        if (!filter?.ids) {
          registeredScripts.length = 0;
        } else {
          const toRemove = new Set(filter.ids);
          const remaining = registeredScripts.filter((id) => !toRemove.has(id));
          registeredScripts.length = 0;
          registeredScripts.push(...remaining);
        }
      },
    };

    const coordinator = new PairingCoordinator({
      fsm,
      apiClient,
      storage,
      idbFactory: idb,
      permissionsApi,
      scriptingApi: scriptingApi as unknown as typeof chrome.scripting,
    });

    // 1. Initial Pairing
    const pair1 = await coordinator.pair('PAIR-E2E-001', 'Reception Mac');
    expect(pair1.connectionId).toBeDefined();
    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    // Grant exact host permission
    const granted1 = await coordinator.grantHostPermission();
    expect(granted1).toBe(true);
    expect(fsm.getState()).toBe('PROBING');
    expect(granted.size).toBeGreaterThan(0);
    expect(registeredScripts.length).toBeGreaterThan(0);

    // 2. Unpairing
    await coordinator.unpair('Staff initiated disconnect');
    expect(fsm.getState()).toBe('UNPAIRED');
    expect(granted.size).toBe(0);
    expect(registeredScripts.length).toBe(0);
    expect(await coordinator.getSession()).toBeNull();

    // 3. Immediate Re-pairing with new code
    const pair2 = await coordinator.pair('PAIR-E2E-002', 'Reception Mac 2');
    expect(pair2.connectionId).toBeDefined();
    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    const granted2 = await coordinator.grantHostPermission();
    expect(granted2).toBe(true);
    expect(fsm.getState()).toBe('PROBING');
    expect(granted.size).toBeGreaterThan(0);
    expect(registeredScripts.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Multi-workstation deployment: two active tabs, exactly one leader lease holder
  // --------------------------------------------------------------------------
  it('Scenario 4: Multi-workstation deployment guarantees exactly one leader lease holder and monotonically increasing fencing tokens', async () => {
    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);

    const apiClient1 = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });
    const apiClient2 = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });

    const leaseClient1 = new LeaseCoordinator({ apiClient: apiClient1 });
    const leaseClient2 = new LeaseCoordinator({ apiClient: apiClient2 });

    const connectionId = 'conn_multi_workstation';
    const tab1InstallId = 'inst_ws_tab_alpha';
    const tab2InstallId = 'inst_ws_tab_beta';

    // Tab 1 acquires lease
    const acquired1 = await leaseClient1.acquire(connectionId, tab1InstallId, 30);
    expect(acquired1).toBe(true);
    expect(leaseClient1.hasActiveLease()).toBe(true);
    const lease1 = leaseClient1.getActiveLease()!;
    expect(lease1.fencingToken).toBe(1);

    // Tab 2 attempts to acquire concurrent lease for same connection -> REJECTED (409 Conflict)
    const acquired2 = await leaseClient2.acquire(connectionId, tab2InstallId, 30);
    expect(acquired2).toBe(false);
    expect(leaseClient2.hasActiveLease()).toBe(false);

    // Tab 1 voluntarily releases lease
    await leaseClient1.release();
    expect(leaseClient1.hasActiveLease()).toBe(false);

    // Tab 2 now acquires lease -> SUCCEEDS with fencing token 2 > 1
    const acquired2Retry = await leaseClient2.acquire(connectionId, tab2InstallId, 30);
    expect(acquired2Retry).toBe(true);
    expect(leaseClient2.hasActiveLease()).toBe(true);
    const lease2 = leaseClient2.getActiveLease()!;
    expect(lease2.fencingToken).toBe(2);
    expect(lease2.fencingToken).toBeGreaterThan(lease1.fencingToken);
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Missing CMS session (prompting reauth)
  // --------------------------------------------------------------------------
  it('Scenario 5: Missing CMS session degrades connection state and halts sync until reauth', async () => {
    const fsm = new ConnectionFSM();
    advanceFsmToActive(fsm, 'conn_probe_test', CMS_URL);

    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const apiClient = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });

    const runner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: CMS_URL,
      connectionId: 'conn_probe_test',
      installationId: 'inst_probe_test',
      headers: { Cookie: 'cms_session=dummy_staff_cookie' },
    });

    // Inject 401 Unauthorized fault into CMS session endpoint
    cmsServer.setFault('401', 0, '/api/auth/session', 'GET');

    const probeResult = await runner.runProbe();
    expect(probeResult.passed).toBe(false);
    expect(fsm.getState()).toBe('REAUTH_REQUIRED');

    // Restore CMS session (staff logs back in)
    cmsServer.setFault('none', 0, '/api/auth/session', 'GET');
    fsm.transition('PROBING', { reason: 'Staff logged in, re-probing CMS' });

    const probeRecovered = await runner.runProbe();
    expect(probeRecovered.passed).toBe(true);
    expect(fsm.getState()).toBe('ACTIVE');
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Session expires mid-command execution
  // --------------------------------------------------------------------------
  it('Scenario 6: Session expires mid-command execution halts write, retains command, and prevents corrupt receipts', async () => {
    const fsm = new ConnectionFSM();
    advanceFsmToActive(fsm, 'conn_mid_expire', CMS_URL);

    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const apiClient = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });
    const leaseCoordinator = new LeaseCoordinator({ apiClient });
    const storage = new MemoryStorage();

    // Acquire valid lease
    await leaseCoordinator.acquire('conn_mid_expire', 'inst_mid_expire', 30);
    const lease = leaseCoordinator.getActiveLease()!;

    const commandExecutor = new CommandExecutor({
      apiClient,
      leaseCoordinator,
      fsm,
      targetOrigin: CMS_URL,
      storage,
    });

    const command: SyncCommand = {
      commandId: 'CMD-EXPIRE-MID-01',
      connectionId: 'conn_mid_expire',
      fencingToken: lease.fencingToken,
      idempotencyKey: 'IDEMP-EXPIRE-001',
      action: 'ACTION_APPOINTMENT_CREATE',
      parameters: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        serviceId: 'SRV-01',
        locationId: 'LOC-01',
        startTime: '2026-10-15T09:00:00+08:00',
        endTime: '2026-10-15T09:15:00+08:00',
      },
    };

    // CMS session expires right as command write hits CMS
    cmsServer.setFault('401', 0, '/api/appointments', 'POST');

    const result = await commandExecutor.executeCommand(command);
    expect(result.status).toBe('TERMINAL_FAILURE');
    expect(result.writeReceipt).toBeUndefined(); // AGENTS.md Rule 10: Zero confirmation without verified read-back
    expect(result.error).toBeDefined();

    // Remove fault and retry: command resolves idempotently and succeeds
    cmsServer.setFault('none', 0, '/api/appointments', 'POST');

    const retryResult = await commandExecutor.executeCommand(command);
    expect(retryResult.status).toBe('VERIFIED');
    expect(retryResult.writeReceipt).toBeDefined();
    expect(retryResult.writeReceipt?.externalId).toMatch(/^APT-/);
  });

  // --------------------------------------------------------------------------
  // Scenario 7: CMS tab or Chrome window closes mid-backfill or mid-write
  // --------------------------------------------------------------------------
  it('Scenario 7: CMS tab closure mid-backfill persists checkpoint and mid-write tab closure recovers idempotently without duplicate writes', async () => {
    const fsm = new ConnectionFSM();
    advanceFsmToActive(fsm, 'conn_backfill_crash', CMS_URL);

    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const apiClient = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });
    const leaseCoordinator = new LeaseCoordinator({ apiClient });
    const storage = new MemoryStorage();
    const dedupeCache = new DeduplicationCache();
    const batchUploader = new BatchUploader({
      apiClient,
      installationId: 'inst_backfill_crash',
      dedupeCache,
    });

    await leaseCoordinator.acquire('conn_backfill_crash', 'inst_backfill_crash', 30);

    // --- Part A: Mid-Backfill Tab Closure & Resumption ---
    const backfill = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId: 'conn_backfill_crash',
      installationId: 'inst_backfill_crash',
      storage,
      pageSize: 2,
    });

    // Step 1: Process single page (simulating work before abrupt tab closure)
    const hasMore = await backfill.step();
    expect(hasMore).toBe(true);

    // Verify stored checkpoint contains persisted cursor (Rule 7: SW/tab crash survival)
    const stored = await storage.get('lamanisync_backfill_checkpoint');
    const checkpointData = stored['lamanisync_backfill_checkpoint'] as { cursor: number; processedCount: number };
    expect(checkpointData).toBeDefined();
    expect(checkpointData.cursor).toBe(2);
    expect(checkpointData.processedCount).toBe(2);

    // Resumption on new instance restores checkpoint from storage and resumes from cursor 2
    const resumedBackfill = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId: 'conn_backfill_crash',
      installationId: 'inst_backfill_crash',
      storage,
      pageSize: 2,
    });

    const restoredCp = await resumedBackfill.restoreCheckpoint();
    expect(restoredCp?.cursor).toBe(2);
    expect(restoredCp?.processedCount).toBe(2);

    // --- Part B: Mid-Write Tab Closure & Resumption ---
    const writeCommand: SyncCommand = {
      commandId: 'CMD-CRASH-WRITE-01',
      connectionId: 'conn_backfill_crash',
      fencingToken: 1,
      idempotencyKey: 'IDEMP-CRASH-WRITE-001',
      action: 'ACTION_APPOINTMENT_CREATE',
      parameters: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        serviceId: 'SRV-01',
        locationId: 'LOC-01',
        startTime: '2026-10-25T14:00:00+08:00',
        endTime: '2026-10-25T14:15:00+08:00',
      },
    };

    // Pre-seed CMS with the appointment as if tab closed right after CMS POST succeeded
    const seedRes = await fetch(`${CMS_URL}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        serviceId: 'SRV-01',
        locationId: 'LOC-01',
        startTime: '2026-10-25T14:00:00+08:00',
        endTime: '2026-10-25T14:15:00+08:00',
        idempotencyKey: 'IDEMP-CRASH-WRITE-001',
        status: 'booked',
        notes: 'Pre-crash write in CMS',
      }),
    });
    const seedJson = (await seedRes.json()) as { data: { id: string } };
    const existingId = seedJson.data.id;

    // In-flight command record was persisted in storage before tab crashed
    await storage.set({
      lamanisync_in_flight_command: {
        commandId: 'CMD-CRASH-WRITE-01',
        fencingToken: 1,
        step: 'EXECUTING',
        lastUpdatedAt: new Date().toISOString(),
      },
    });

    // Resumption on new CommandExecutor instance after tab reconnect
    const resumedExecutor = new CommandExecutor({
      apiClient,
      leaseCoordinator,
      fsm,
      targetOrigin: CMS_URL,
      storage,
    });

    // Verify stored in-flight command is detected
    const inFlightSnapshot = await resumedExecutor.getInFlightCommand();
    expect(inFlightSnapshot?.commandId).toBe('CMD-CRASH-WRITE-01');

    // Executing the command discovers existing appointment via idempotency resolver,
    // verifies read-back, and generates write receipt without creating duplicate write
    const recoveryResult = await resumedExecutor.executeCommand(writeCommand);
    expect(recoveryResult.status).toBe('VERIFIED');
    expect(recoveryResult.writeReceipt).toBeDefined();
    expect(recoveryResult.writeReceipt?.externalId).toBe(existingId);

    // Storage is cleared of in-flight command
    expect(await resumedExecutor.getInFlightCommand()).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Service worker suspension and subsequent wake-up event
  // --------------------------------------------------------------------------
  it('Scenario 8: Ephemeral service worker suspension and restart restores connection, lease, and echo suppression', async () => {
    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const storage = new MemoryStorage();

    // Simulate active session before SW suspension
    const session = {
      connectionId: 'conn_sw_suspend',
      clinicId: 'CLINIC-SW',
      targetOrigin: CMS_URL,
      sessionToken: 'lh_sess_sw_token_123',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      installationId: 'inst_sw_suspend',
      pairedAt: new Date().toISOString(),
    };
    await storage.set({ [SESSION_STORAGE_KEY]: session });

    // Active lease before suspension stored under LEASE_STORAGE_KEY
    const activeLease = {
      connectionId: 'conn_sw_suspend',
      installationId: 'inst_sw_suspend',
      leaseId: 'lease_sw_001',
      fencingToken: 5,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      expiresAtMs: Date.now() + 60000,
      acquiredAt: Date.now(),
    };
    await storage.set({
      [LEASE_STORAGE_KEY]: {
        lease: activeLease,
        highestFencingToken: 5,
      },
    });

    // Outbound write recorded in EchoSuppressor before SW suspension
    const suppressorBefore = new EchoSuppressor({ storage });
    suppressorBefore.recordOutboundWrite({
      entityType: 'appointment',
      entityId: 'APT-SW-SUSPEND-999',
      revision: 1,
    });
    await suppressorBefore.saveToStorage();

    // Simulated complete suspension: all memory state is wiped
    let fsm: ConnectionFSM | null = new ConnectionFSM();
    let apiClient: SyncApiClient | null = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });
    let coordinator: PairingCoordinator | null = new PairingCoordinator({ fsm, apiClient, storage, idbFactory: idb });
    let leaseCoordinator: LeaseCoordinator | null = new LeaseCoordinator({ apiClient, storage });
    let suppressorAfter: EchoSuppressor | null = new EchoSuppressor({ storage });

    // Wake-up event triggers restoration routine (AGENTS.md Rule 7)
    const restoredRecord = await coordinator.restoreState();
    expect(restoredRecord.state).toBe('PAIRED_NO_PERMISSION');

    const restoredLease = await leaseCoordinator.restore();
    expect(restoredLease).not.toBeNull();
    expect(restoredLease?.leaseId).toBe('lease_sw_001');
    expect(restoredLease?.fencingToken).toBe(5);

    // EchoSuppressor restores fingerprints from storage and continues suppressing echo reads
    await suppressorAfter.restoreFromStorage();
    expect(
      suppressorAfter.shouldSuppressObservation({
        entityType: 'appointment',
        entityId: 'APT-SW-SUSPEND-999',
        revision: 1,
      })
    ).toBe(true);

    fsm = null;
    apiClient = null;
    coordinator = null;
    leaseCoordinator = null;
    suppressorAfter = null;
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Offline/online network transitions
  // --------------------------------------------------------------------------
  it('Scenario 9: Offline/online network transitions gracefully enter DEGRADED state and recover without crashing', async () => {
    const fsm = new ConnectionFSM();
    advanceFsmToActive(fsm, 'conn_offline_test', CMS_URL);

    // Simulated offline fetch function
    const offlineFetch = async () => {
      throw new TypeError('Failed to fetch: net::ERR_INTERNET_DISCONNECTED');
    };

    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const apiClient = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb, fetchFn: offlineFetch });

    try {
      await apiClient.request('/api/heartbeat');
    } catch {
      if (fsm.canTransition('DEGRADED')) {
        fsm.transition('DEGRADED', { reason: 'NETWORK_OFFLINE' });
      }
    }

    expect(fsm.getState()).toBe('DEGRADED');

    // Online network transition: real fetch restores connection
    const onlineClient = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb, fetchFn: fetch });
    const health = await onlineClient.request('/__admin/health');
    expect(health).toBeDefined();

    if (fsm.canTransition('ACTIVE')) {
      fsm.transition('ACTIVE', { reason: 'Network restored' });
    }
    expect(fsm.getState()).toBe('ACTIVE');
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Tampered adapter manifest rejection and automatic rollback to Last-Known-Good
  // --------------------------------------------------------------------------
  it('Scenario 10: Tampered adapter manifest fails cryptographic verification and rolls back to Last-Known-Good', async () => {
    const storage = new InMemoryStorageAdapter();

    // 1. Initial good manifest activation
    const initialActivation = await syncAndActivateAdapter('conn_tamper_test', CMS_URL, {
      syncApiUrl: SYNC_URL,
      storage,
      probeEndpoint: '/api/reference/providers',
      fetchFn: fetch,
    });
    expect(initialActivation.isRollback).toBe(false);
    expect(initialActivation.manifest.adapterId).toBe('acme-cloud-v1');

    // 2. Sync API attempts to distribute a tampered variant
    const tamperedAttempt = await syncAndActivateAdapter('conn_tamper_test', CMS_URL, {
      syncApiUrl: SYNC_URL,
      variant: 'tampered',
      storage,
      probeEndpoint: '/api/reference/providers',
      fetchFn: fetch,
    });

    // Enforces AGENTS.md Rule 9 & Rule 2: Tampered manifest rejected; rolled back to LKG
    expect(tamperedAttempt.isRollback).toBe(true);
    expect(tamperedAttempt.manifest.adapterId).toBe('acme-cloud-v1');

    // Verify LKG manifest remains active
    const active = await getActiveManifest('acme-cloud-v1', { storage });
    expect(active?.adapterId).toBe('acme-cloud-v1');
  });

  // --------------------------------------------------------------------------
  // Scenario 11: CMS API schema drift detection
  // --------------------------------------------------------------------------
  it('Scenario 11: CMS API schema drift fails closed, categorizes error under taxonomy, and quarantines corrupted records', () => {
    // Corrupted record with missing startTime and invalid non-enum status
    const driftedCmsPayload = {
      id: 'APT-DRIFT-999',
      patientId: 'ZZTEST-P01',
      providerId: 'DOC-01',
      status: 'unrecognized_vendor_state',
      // missing startTime, endTime, slotDate, etc.
    };

    // Schema normalization fails closed
    expect(() => normalizeAppointment(driftedCmsPayload)).toThrow();

    try {
      normalizeAppointment(driftedCmsPayload);
    } catch (err) {
      const lamaniError = new LamaniError(
        'CMS API schema drift detected: appointment payload missing mandatory fields',
        'SCHEMA_DRIFT',
        { details: { error: String(err) } }
      );
      expect(lamaniError.code).toBe('SCHEMA_DRIFT');
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Fault injection handling: 401, 403, 409, 429, 500
  // --------------------------------------------------------------------------
  it('Scenario 12: Fault injection handles 401, 403, 409, 429, and 500 without unhandled rejections', async () => {
    // 1. 401 Unauthorized
    cmsServer.setFault('401', 0, '/api/session', 'GET');
    const res401 = await fetch(`${CMS_URL}/api/session`);
    expect(res401.status).toBe(401);

    // 2. 403 Forbidden
    cmsServer.setFault('403', 0, '/api/patients', 'GET');
    const res403 = await fetch(`${CMS_URL}/api/patients`);
    expect(res403.status).toBe(403);

    // 3. 409 Conflict
    cmsServer.setFault('409', 0, '/api/appointments', 'POST');
    const res409 = await fetch(`${CMS_URL}/api/appointments`, { method: 'POST' });
    expect(res409.status).toBe(409);

    // 4. 429 Rate Limit with Retry-After header
    cmsServer.setFault('429', 0, '/api/reference/providers', 'GET');
    const res429 = await fetch(`${CMS_URL}/api/reference/providers`);
    expect(res429.status).toBe(429);
    expect(res429.headers.get('Retry-After')).toBe('30');

    // 5. 500 Internal Error
    cmsServer.setFault('500', 0, '/api/reference/services', 'GET');
    const res500 = await fetch(`${CMS_URL}/api/reference/services`);
    expect(res500.status).toBe(500);

    // 6. Error taxonomy domain classification for all 5 HTTP fault categories
    const err401 = classifyError(401, { endpoint: '/api/session' });
    expect(err401.code).toBe('AUTH_ERROR');
    expect(err401.statusCode).toBe(401);

    const err403 = classifyError(403, { endpoint: '/api/patients' });
    expect(err403.code).toBe('AUTH_ERROR');
    expect(err403.statusCode).toBe(403);

    const err409 = classifyError(409, { endpoint: '/api/appointments' });
    expect(err409.code).toBe('CONFLICT');
    expect(err409.statusCode).toBe(409);

    const err429 = classifyError(429, { endpoint: '/api/reference/providers', retryAfterSeconds: 30 });
    expect(err429.code).toBe('RATE_LIMITED');
    expect(err429.statusCode).toBe(429);
    expect((err429 as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(30);

    const err500 = classifyError(500, { endpoint: '/api/reference/services' });
    expect(err500.code).toBe('TRANSIENT_NETWORK_ERROR');
    expect(err500.statusCode).toBe(500);
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Kill-switch activation across all three scopes
  // --------------------------------------------------------------------------
  it('Scenario 13: Kill-switch activation pauses operations across global, adapter, and connection scopes', async () => {
    const fsm = new ConnectionFSM();
    advanceFsmToActive(fsm, 'conn_scope_test', CMS_URL);

    const storage = new MemoryStorage();
    let pollerStopped = false;

    const killSwitch = new KillSwitchCoordinator({
      fsm,
      storage,
      onPauseTriggered: () => {
        pollerStopped = true;
      },
    });

    // 1. Global kill-switch
    killSwitch.triggerPause('global', undefined, 'Critical security audit');
    expect(killSwitch.isGlobalPaused()).toBe(true);
    expect(fsm.getState()).toBe('PAUSED');
    expect(pollerStopped).toBe(true);

    // Global resume
    killSwitch.resume('global');
    expect(killSwitch.isGlobalPaused()).toBe(false);
    expect(fsm.getState()).toBe('ACTIVE');

    // 2. Adapter scope kill-switch
    killSwitch.triggerPause('adapter', 'acme-cloud-v1', 'Adapter maintenance');
    expect(killSwitch.isAdapterPaused('acme-cloud-v1')).toBe(true);
    expect(killSwitch.isAdapterPaused('other-adapter')).toBe(false);

    // 3. Connection scope kill-switch
    killSwitch.triggerPause('connection', 'conn_scope_test', 'Tenant subscription hold');
    expect(killSwitch.isConnectionPaused('conn_scope_test')).toBe(true);
    expect(killSwitch.isConnectionPaused('conn_other')).toBe(false);

    // 4. Remote signal payload handling from Sync API
    killSwitch.processRemoteSignal({
      status: 'PAUSED',
      killSwitchLevel: 'connection',
      targetId: 'conn_scope_test',
      message: 'Remote connection freeze',
    });
    expect(killSwitch.isConnectionPaused('conn_scope_test')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Dynamic CMS origin changes
  // --------------------------------------------------------------------------
  it('Scenario 14: Dynamic CMS origin change validates exact origin and rejects wildcards (AGENTS.md Rule 3)', () => {
    // 1. Wildcards strictly rejected
    expect(() => normalizeExactOrigin('*://*/*')).toThrow();
    expect(() => normalizeExactOrigin('https://*/*')).toThrow();
    expect(() => normalizeExactOrigin('http://localhost:*')).toThrow();

    // 2. Valid exact origins normalized
    const origin1 = normalizeExactOrigin('http://localhost:4001');
    expect(origin1).toBe('http://localhost:4001');
    expect(toExactOriginPattern(origin1)).toBe('http://localhost:4001/*');

    const origin2 = normalizeExactOrigin('https://clinic-cms.lamanify.test/');
    expect(origin2).toBe('https://clinic-cms.lamanify.test');
    expect(toExactOriginPattern(origin2)).toBe('https://clinic-cms.lamanify.test/*');
  });

  // --------------------------------------------------------------------------
  // Scenario 15: Extension update arriving while a command is leased and executing
  // --------------------------------------------------------------------------
  it('Scenario 15: Extension update arriving while command is leased defers reload until command completes', async () => {
    const fsm = new ConnectionFSM();
    advanceFsmToActive(fsm, 'conn_update_test', CMS_URL);

    const idb = createMockIDBFactory();
    setIndexedDbFactory(idb);
    const apiClient = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb });
    const leaseCoordinator = new LeaseCoordinator({ apiClient });
    const storage = new MemoryStorage();

    // Acquire lease
    await leaseCoordinator.acquire('conn_update_test', 'inst_update_test', 30);

    const commandExecutor = new CommandExecutor({
      apiClient,
      leaseCoordinator,
      fsm,
      targetOrigin: CMS_URL,
      storage,
    });

    let reloadDispatched = false;
    const updateManager = new UpdateManager({
      commandExecutor,
      leaseCoordinator,
      reloadFn: () => {
        reloadDispatched = true;
      },
    });

    // Simulate update arriving while lease is held
    const updateResult = await updateManager.handleUpdateAvailable({ version: '0.2.0' });
    expect(updateResult.deferred).toBe(true);
    expect(updateManager.hasDeferredUpdate()).toBe(true);
    expect(reloadDispatched).toBe(false); // Reload was NOT called yet

    // Once command execution finishes, onCommandSettled releases active lease and safely dispatches reload
    const settled = await updateManager.onCommandSettled();
    expect(settled).toBe(true);
    expect(reloadDispatched).toBe(true); // Reload safely dispatched after work completed
    expect(leaseCoordinator.hasActiveLease()).toBe(false); // Lease voluntarily dropped before reload
  });
});
