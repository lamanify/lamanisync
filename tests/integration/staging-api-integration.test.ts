// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockSyncApiServer } from '../../test-harness/mock-sync-api/server.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { PairingCoordinator, SESSION_STORAGE_KEY, type StorageAdapter } from '../../src/background/pairing.js';
import { TokenManager } from '../../src/background/token-manager.js';
import { KillSwitchCoordinator } from '../../src/background/kill-switch.js';
import { OutboxPoller } from '../../src/background/outbox-poller.js';
import { LeaseCoordinator } from '../../src/background/lease-client.js';
import { CommandExecutor } from '../../src/background/command-executor.js';
import { EchoSuppressor } from '../../src/background/echo-suppressor.js';
import { setIndexedDbFactory } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';
import { LamaniError } from '../../src/core/errors.js';
import type { SyncEvent } from '../../src/core/contracts/events.js';

function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, unknown>();
  return {
    get: async (keys) => {
      const res: Record<string, unknown> = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        if (map.has(k)) res[k] = map.get(k);
      }
      return res;
    },
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) {
        map.set(k, v);
      }
    },
    remove: async (keys) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        map.delete(k);
      }
    },
  };
}

describe('Phase 10: Staging API Integration & Security Tests', () => {
  const SERVER_PORT = 4072;
  const syncServer = new MockSyncApiServer(SERVER_PORT);
  const baseUrl = `http://localhost:${SERVER_PORT}`;

  let mockIdb: IDBFactory;
  let mockStorage: StorageAdapter;
  let fsm: ConnectionFSM;
  let apiClient: SyncApiClient;
  let coordinator: PairingCoordinator;
  let tokenManager: TokenManager;
  let killSwitch: KillSwitchCoordinator;
  let leaseCoordinator: LeaseCoordinator;
  let poller: OutboxPoller;

  beforeAll(async () => {
    await syncServer.start();
  });

  afterAll(async () => {
    await syncServer.stop();
  });

  beforeEach(async () => {
    await fetch(`${baseUrl}/__admin/reset`, { method: 'POST' });
    mockIdb = createMockIDBFactory();
    setIndexedDbFactory(mockIdb);
    mockStorage = createMemoryStorage();

    fsm = new ConnectionFSM();
    apiClient = new SyncApiClient({ baseUrl, idbFactory: mockIdb });
    coordinator = new PairingCoordinator({
      fsm,
      apiClient,
      storage: mockStorage,
      idbFactory: mockIdb,
    });

    killSwitch = new KillSwitchCoordinator({
      fsm,
      onPauseTriggered: () => {
        poller?.stop();
      },
    });

    tokenManager = new TokenManager({
      apiClient,
      storage: mockStorage,
      fsm,
      renewalThresholdMs: 300_000,
    });

    apiClient.setKillSwitchHandler((payload) => {
      killSwitch.processRemoteSignal(payload);
    });

    apiClient.setTokenRecoveryHandler(async () => {
      return tokenManager.handleTokenExpired();
    });

    leaseCoordinator = new LeaseCoordinator({ apiClient });
    const echoSuppressor = new EchoSuppressor();
    const commandExecutor = new CommandExecutor({
      apiClient,
      leaseCoordinator,
      fsm,
      echoSuppressor,
    });

    poller = new OutboxPoller({
      apiClient,
      leaseCoordinator,
      commandExecutor,
      fsm,
      connectionId: 'conn_mock_67890',
      killSwitches: {
        isGlobalPaused: () => killSwitch.isGlobalPaused(),
        isAdapterPaused: (id?: string) => (id ? killSwitch.isAdapterPaused(id) : false),
        isConnectionPaused: (id?: string) => (id ? killSwitch.isConnectionPaused(id) : false),
      },
    });
  });

  it('completes device pairing handshake with signed payload and persists session', async () => {
    const pairResult = await coordinator.pair('PAIR-TEST-123', 'Staging Test Runner');

    expect(pairResult.installationId).toContain('inst_mock_');
    expect(pairResult.connectionId).toBe('conn_mock_67890');
    expect(pairResult.sessionToken).toBeTruthy();
    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    const stored = await coordinator.getSession();
    expect(stored).not.toBeNull();
    expect(stored?.installationId).toBe(pairResult.installationId);
  });

  it('rejects captured past requests with clock drift > 60s or duplicate nonces', async () => {
    // Pair device first
    const pairResult = await coordinator.pair('PAIR-TEST-123');

    // 1. Send request with clock drift > 60s (stolen timestamp from 10 minutes ago)
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const staleRes = await fetch(`${baseUrl}/v1/sync/installations/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pairResult.sessionToken}`,
        'x-device-timestamp': staleTimestamp,
        'x-device-nonce': 'nonce-stale-1',
      },
      body: JSON.stringify({ installationId: pairResult.installationId }),
    });

    expect(staleRes.status).toBe(401);
    const staleBody = await staleRes.json();
    expect(staleBody.error).toBe('CLOCK_DRIFT_EXCEEDED');

    // 2. Send request with future clock drift > 60s
    const futureTimestamp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const futureRes = await fetch(`${baseUrl}/v1/sync/installations/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pairResult.sessionToken}`,
        'x-device-timestamp': futureTimestamp,
        'x-device-nonce': 'nonce-future-1',
      },
      body: JSON.stringify({ installationId: pairResult.installationId }),
    });

    expect(futureRes.status).toBe(401);
    const futureBody = await futureRes.json();
    expect(futureBody.error).toBe('CLOCK_DRIFT_EXCEEDED');

    // 3. Send valid fresh request
    const validTimestamp = new Date().toISOString();
    const validRes = await fetch(`${baseUrl}/v1/sync/installations/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pairResult.sessionToken}`,
        'x-device-timestamp': validTimestamp,
        'x-device-nonce': 'nonce-replay-unique',
      },
      body: JSON.stringify({ installationId: pairResult.installationId }),
    });

    expect(validRes.status).toBe(200);

    // 4. Replay identical nonce (replay attack)
    const replayedRes = await fetch(`${baseUrl}/v1/sync/installations/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pairResult.sessionToken}`,
        'x-device-timestamp': new Date().toISOString(),
        'x-device-nonce': 'nonce-replay-unique', // REPLAY!
      },
      body: JSON.stringify({ installationId: pairResult.installationId }),
    });

    expect(replayedRes.status).toBe(401);
    const replayedBody = await replayedRes.json();
    expect(replayedBody.error).toBe('NONCE_REPLAY_DETECTED');
  });

  it('renews session tokens cleanly without interrupting background sync', async () => {
    const pairResult = await coordinator.pair('PAIR-TEST-123');
    const initialToken = pairResult.sessionToken;

    // Simulate session expiring in 1 minute
    const existing = await coordinator.getSession();
    const expiringSoon = {
      ...existing!,
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    };
    await mockStorage.set({ [SESSION_STORAGE_KEY]: expiringSoon });

    // Proactive check triggers renewal
    const didRenew = await tokenManager.checkAndRenew();
    expect(didRenew).toBe(true);

    const renewedToken = apiClient.getSessionToken();
    expect(renewedToken).toBeTruthy();
    expect(renewedToken).not.toBe(initialToken);

    // Verified stored session reflects renewed token
    const stored = await tokenManager.getStoredSession();
    expect(stored?.sessionToken).toBe(renewedToken);
  });

  it('remotely pauses operations via kill-switch across global, adapter, and connection levels', async () => {
    await coordinator.pair('PAIR-TEST-123');

    // Transition to ACTIVE via SHADOW
    fsm.transition('PROBING', { reason: 'User granted host permission' });
    fsm.transition('SHADOW', { reason: 'Adapter probe passed' });
    fsm.transition('ACTIVE', { reason: 'Shadow phase complete' });
    expect(fsm.getState()).toBe('ACTIVE');

    // 1. Global Kill-Switch Trigger
    await fetch(`${baseUrl}/__admin/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'global',
        paused: true,
        reason: 'Emergency security audit',
      }),
    });

    // Outbound API call receives 403 PAUSED
    await expect(apiClient.heartbeat('inst_mock_1')).rejects.toThrow(LamaniError);

    // Immediately halted and transitioned to PAUSED
    expect(killSwitch.isGlobalPaused()).toBe(true);
    expect(fsm.getState()).toBe('PAUSED');

    // Resume global
    await fetch(`${baseUrl}/__admin/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'global', paused: false }),
    });
    killSwitch.resume('global');
    expect(fsm.getState()).toBe('ACTIVE');

    // 2. Connection-Level Kill-Switch Trigger
    await fetch(`${baseUrl}/__admin/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'connection',
        targetId: 'conn_mock_67890',
        paused: true,
        reason: 'Clinic subscription suspended',
      }),
    });

    // Request for this connection triggers 403 PAUSED
    await expect(apiClient.fetchNextCommand('conn_mock_67890')).rejects.toThrow(LamaniError);
    expect(fsm.getState()).toBe('PAUSED');
    expect(killSwitch.isConnectionPaused('conn_mock_67890')).toBe(true);

    // Resume connection
    await fetch(`${baseUrl}/__admin/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'connection', targetId: 'conn_mock_67890', paused: false }),
    });
    killSwitch.resume('connection', 'conn_mock_67890');
    expect(fsm.getState()).toBe('ACTIVE');

    // 3. Adapter-Level Kill-Switch Trigger
    await fetch(`${baseUrl}/__admin/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'adapter',
        targetId: 'acme-cloud-v1',
        paused: true,
        reason: 'Adapter version deprecated',
      }),
    });

    const adapterRes = await fetch(`${baseUrl}/v1/sync/connections/conn_1/adapter`, {
      headers: { 'x-adapter-id': 'acme-cloud-v1' },
    });
    expect(adapterRes.status).toBe(403);
    const adapterBody = await adapterRes.json();
    expect(adapterBody.error).toBe('PAUSED');
    expect(adapterBody.killSwitchLevel).toBe('adapter');

    killSwitch.triggerPause('adapter', 'acme-cloud-v1', 'Adapter revoked');
    expect(killSwitch.isAdapterPaused('acme-cloud-v1')).toBe(true);

    poller.setAdapterManifest({
      adapterId: 'acme-cloud-v1',
      version: '1.0.0',
      name: 'Acme Cloud',
      capabilities: ['APPOINTMENT_WRITE'],
      endpoints: {},
      targetOrigin: 'http://localhost:4001',
    });
    expect(poller.isPaused()).toBe(true);

    killSwitch.resume('adapter', 'acme-cloud-v1');
    expect(killSwitch.isAdapterPaused('acme-cloud-v1')).toBe(false);
  });

  it('guarantees idempotency of event batches and write receipts', async () => {
    const pairResult = await coordinator.pair('PAIR-TEST-123');
    const installationId = pairResult.installationId;

    const events: SyncEvent[] = [
      {
        eventId: 'evt_idempotent_001',
        entityType: 'appointment',
        entityId: 'APT-100',
        eventType: 'APPOINTMENT_BOOKED',
        revision: 1,
        occurredAt: new Date().toISOString(),
        payload: { patientId: 'ZZTEST-P01' },
      },
    ];

    // 1. Submit event batch first time
    const batch1 = await apiClient.sendEventBatch(installationId, events, 'batch_fixed_id_100');
    expect(batch1.acknowledged).toBe(true);
    expect(batch1.batchId).toBe('batch_fixed_id_100');
    expect(batch1.processedCount).toBe(1);

    // 2. Re-submit identical batch (network retry or re-send)
    const batch2 = await apiClient.sendEventBatch(installationId, events, 'batch_fixed_id_100');
    expect(batch2.acknowledged).toBe(true);
    expect(batch2.batchId).toBe('batch_fixed_id_100');
    expect(batch2.checkpoint).toBe(batch1.checkpoint); // exact same cached receipt

    // Verify events were not duplicated on backend
    const summary = await apiClient.getReconcileSummary('conn_mock_67890');
    expect(summary.totalEvents).toBe(1);

    // 3. Submit write receipt for command execution
    const receipt1 = await apiClient.reportCommandResult('CMD-TEST-001', {
      status: 'VERIFIED',
      writeReceipt: {
        externalId: 'APT-100',
        revision: 1,
        verifiedAt: new Date().toISOString(),
      },
    });
    expect(receipt1.acknowledged).toBe(true);

    // 4. Re-submit identical command write receipt
    const receipt2 = await apiClient.reportCommandResult('CMD-TEST-001', {
      status: 'VERIFIED',
      writeReceipt: {
        externalId: 'APT-100',
        revision: 1,
        verifiedAt: new Date().toISOString(),
      },
    });
    expect(receipt2.acknowledged).toBe(true);
    expect(receipt2.commandId).toBe('CMD-TEST-001');
  });

  it('performs clean unpair and server-side installation revocation', async () => {
    const pairResult = await coordinator.pair('PAIR-TEST-123');
    expect(await coordinator.getSession()).not.toBeNull();

    await coordinator.unpair('Test unpair sequence');

    expect(fsm.getState()).toBe('UNPAIRED');
    expect(await coordinator.getSession()).toBeNull();
    expect(apiClient.getSessionToken()).toBeNull();

    // Heartbeat after revocation fails with 401 UNAUTHORIZED
    await expect(apiClient.heartbeat(pairResult.installationId)).rejects.toThrow(LamaniError);
  });
});
