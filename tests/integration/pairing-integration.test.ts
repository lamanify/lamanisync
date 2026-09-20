// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MockSyncApiServer } from '../../test-harness/mock-sync-api/server.js';
import { PairingCoordinator, SESSION_STORAGE_KEY, type StorageAdapter } from '../../src/background/pairing.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { setIndexedDbFactory, getDevicePublicKey } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';
import type { ChromePermissionsApi } from '../../src/background/permissions.js';

class IntegrationMemoryStorage implements StorageAdapter {
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
}

describe('Phase 4 Pairing & Device Identity Integration Test', () => {
  const PORT = 4005;
  const BASE_URL = `http://localhost:${PORT}`;
  const syncServer = new MockSyncApiServer(PORT);
  let idbFactory: IDBFactory;
  let storage: IntegrationMemoryStorage;
  let permissionsApi: ChromePermissionsApi;
  let grantedOrigins: Set<string>;

  beforeAll(async () => {
    await syncServer.start();
  });

  afterAll(async () => {
    await syncServer.stop();
  });

  beforeEach(async () => {
    await fetch(`${BASE_URL}/__admin/reset`, { method: 'POST' });
    idbFactory = createMockIDBFactory();
    setIndexedDbFactory(idbFactory);
    storage = new IntegrationMemoryStorage();
    grantedOrigins = new Set();

    permissionsApi = {
      request: vi.fn().mockImplementation(async ({ origins }: { origins?: string[] }) => {
        if (origins) {
          for (const o of origins) grantedOrigins.add(o);
        }
        return true;
      }),
      contains: vi.fn().mockImplementation(async ({ origins }: { origins?: string[] }) => {
        if (!origins) return false;
        return origins.every((o) => grantedOrigins.has(o));
      }),
      remove: vi.fn().mockImplementation(async ({ origins }: { origins?: string[] }) => {
        if (origins) {
          for (const o of origins) grantedOrigins.delete(o);
        }
        return true;
      }),
    };
  });

  it('executes full pairing handshake, exact-origin permission grant, and clean revocation', async () => {
    const fsm = new ConnectionFSM();
    const apiClient = new SyncApiClient({ baseUrl: BASE_URL });
    const coordinator = new PairingCoordinator({
      fsm,
      apiClient,
      storage,
      permissionsApi,
      idbFactory,
    });

    // 1. Initial state
    expect(fsm.getState()).toBe('UNPAIRED');

    // 2. Perform pairing handshake
    const pairResult = await coordinator.pair('PAIR-TEST-123', 'Integration Test Runner');

    expect(pairResult.installationId).toContain('inst_mock_');
    expect(pairResult.connectionId).toBe('conn_mock_67890');
    expect(pairResult.targetOrigin).toBe('http://localhost:4001');
    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    // Verify session persisted in storage (and contains no CMS credentials/PHI)
    const stored = await storage.get(SESSION_STORAGE_KEY);
    const session = stored[SESSION_STORAGE_KEY] as Record<string, unknown>;
    expect(session).toBeDefined();
    expect(session.installationId).toBe(pairResult.installationId);
    expect(session.targetOrigin).toBe('http://localhost:4001');
    expect(session.password).toBeUndefined();
    expect(session.cookie).toBeUndefined();

    // 3. User grants exact origin host permission
    const granted = await coordinator.grantHostPermission();
    expect(granted).toBe(true);
    expect(fsm.getState()).toBe('PROBING');
    expect(grantedOrigins.has('http://localhost:4001/*')).toBe(true);

    // 4. Server installation is recorded
    expect(syncServer.state.installations.has(pairResult.installationId)).toBe(true);

    // 4b. Acquire leader lease and attach to coordinator
    const lease = await apiClient.acquireLease(pairResult.connectionId, pairResult.installationId, 30);
    expect(lease.status).toBe('GRANTED');
    expect(lease.leaseId).toBeTruthy();
    coordinator.setActiveLease({
      connectionId: pairResult.connectionId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    });
    expect(syncServer.state.leases.has(pairResult.connectionId)).toBe(true);

    // 5. Unpair / Revocation flow
    await coordinator.unpair();

    expect(fsm.getState()).toBe('UNPAIRED');
    // Installation revoked on server
    expect(syncServer.state.installations.has(pairResult.installationId)).toBe(false);
    // Leader lease released on server
    expect(syncServer.state.leases.has(pairResult.connectionId)).toBe(false);
    // Host permissions removed
    expect(grantedOrigins.has('http://localhost:4001/*')).toBe(false);
    // Device key purged
    const pubKey = await getDevicePublicKey(idbFactory);
    expect(pubKey).toBeNull();
    // Storage session purged
    const storedAfter = await storage.get(SESSION_STORAGE_KEY);
    expect(storedAfter[SESSION_STORAGE_KEY]).toBeUndefined();
  });

  it('rejects expired pairing code and resets FSM cleanly', async () => {
    const fsm = new ConnectionFSM();
    const apiClient = new SyncApiClient({ baseUrl: BASE_URL });
    const coordinator = new PairingCoordinator({
      fsm,
      apiClient,
      storage,
      permissionsApi,
      idbFactory,
    });

    try {
      await coordinator.pair('EXPIRED');
      expect.unreachable('Should fail with expired code');
    } catch (err) {
      expect((err as Error).message).toContain('expired');
    }

    expect(fsm.getState()).toBe('UNPAIRED');
  });

  it('safely restores paired state across simulated service worker restart', async () => {
    // 1. Initial pairing on "Worker 1"
    const fsm1 = new ConnectionFSM();
    const client1 = new SyncApiClient({ baseUrl: BASE_URL });
    const coord1 = new PairingCoordinator({
      fsm: fsm1,
      apiClient: client1,
      storage,
      permissionsApi,
      idbFactory,
    });

    await coord1.pair('PAIR-TEST-123');
    await coord1.grantHostPermission();
    expect(fsm1.getState()).toBe('PROBING');

    // 2. Simulate worker suspension & restart with fresh memory state
    const fsm2 = new ConnectionFSM();
    const client2 = new SyncApiClient({ baseUrl: BASE_URL });
    const coord2 = new PairingCoordinator({
      fsm: fsm2,
      apiClient: client2,
      storage,
      permissionsApi,
      idbFactory,
    });

    expect(fsm2.getState()).toBe('UNPAIRED');

    // Restore state from storage and browser permissions
    const restoredRecord = await coord2.restoreState();
    expect(restoredRecord.state).toBe('PROBING');
    expect(restoredRecord.targetOrigin).toBe('http://localhost:4001');
    expect(fsm2.getState()).toBe('PROBING');
  });
});
