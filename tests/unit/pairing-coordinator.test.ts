// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PairingCoordinator, SESSION_STORAGE_KEY, type StorageAdapter } from '../../src/background/pairing.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { setIndexedDbFactory, getDevicePublicKey } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';
import type { ChromePermissionsApi } from '../../src/background/permissions.js';

class MemoryStorageAdapter implements StorageAdapter {
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

describe('PairingCoordinator', () => {
  let fsm: ConnectionFSM;
  let memoryStorage: MemoryStorageAdapter;
  let mockPermissionsApi: ChromePermissionsApi;
  let mockFetch: ReturnType<typeof vi.fn>;
  let apiClient: SyncApiClient;
  let coordinator: PairingCoordinator;

  beforeEach(() => {
    const idbFactory = createMockIDBFactory();
    setIndexedDbFactory(idbFactory);

    fsm = new ConnectionFSM();
    memoryStorage = new MemoryStorageAdapter();

    mockPermissionsApi = {
      request: vi.fn().mockResolvedValue(true),
      contains: vi.fn().mockResolvedValue(false),
      remove: vi.fn().mockResolvedValue(true),
    };

    mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/pair')) {
        return new Response(
          JSON.stringify({
            installationId: 'inst_coord_123',
            connectionId: 'conn_coord_456',
            clinicId: 'CLN-001',
            sessionToken: 'stk_coord_789',
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
            targetOrigin: 'http://localhost:4001',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/revoke')) {
        return new Response(JSON.stringify({ status: 'revoked' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    apiClient = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    coordinator = new PairingCoordinator({
      fsm,
      apiClient,
      storage: memoryStorage,
      permissionsApi: mockPermissionsApi,
      idbFactory,
    });
  });

  it('successful pairing stores session metadata and moves FSM to PAIRED_NO_PERMISSION', async () => {
    expect(fsm.getState()).toBe('UNPAIRED');

    const result = await coordinator.pair('PAIR-TEST-123', 'Dev Machine');

    expect(result.installationId).toBe('inst_coord_123');
    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    const record = fsm.getRecord();
    expect(record.connectionId).toBe('conn_coord_456');
    expect(record.installationId).toBe('inst_coord_123');
    expect(record.targetOrigin).toBe('http://localhost:4001');

    // Check stored session in storage
    const stored = await memoryStorage.get(SESSION_STORAGE_KEY);
    const session = stored[SESSION_STORAGE_KEY] as Record<string, unknown>;
    expect(session).toBeDefined();
    expect(session.sessionToken).toBe('stk_coord_789');
    expect(session.targetOrigin).toBe('http://localhost:4001');
    // Ensure no CMS credentials or passwords stored
    expect(session.password).toBeUndefined();
    expect(session.cookie).toBeUndefined();
  });

  it('pairing failure reverts FSM back to UNPAIRED and throws classified error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'PAIRING_CODE_EXPIRED',
          message: 'The pairing code has expired',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(coordinator.pair('EXPIRED')).rejects.toThrow();
    expect(fsm.getState()).toBe('UNPAIRED');
  });

  it('grantHostPermission prompts exact origin and moves FSM to PROBING', async () => {
    await coordinator.pair('PAIR-TEST-123');
    expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    const granted = await coordinator.grantHostPermission();
    expect(granted).toBe(true);
    expect(mockPermissionsApi.request).toHaveBeenCalledWith({
      origins: ['http://localhost:4001/*'],
    });
    expect(fsm.getState()).toBe('PROBING');
  });

  it('unpair cleanly revokes on server, removes permissions, purges device key, and resets FSM', async () => {
    await coordinator.pair('PAIR-TEST-123');
    await coordinator.grantHostPermission();
    expect(fsm.getState()).toBe('PROBING');

    const keyBefore = await getDevicePublicKey();
    expect(keyBefore).toBeTruthy();

    await coordinator.unpair();

    // FSM transitions through REVOKED -> UNPAIRED
    expect(fsm.getState()).toBe('UNPAIRED');

    // Server revocation called
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/sync/installations/revoke'),
      expect.anything()
    );

    // Permission removed
    expect(mockPermissionsApi.remove).toHaveBeenCalledWith({
      origins: ['http://localhost:4001/*'],
    });

    // Device key purged
    const keyAfter = await getDevicePublicKey();
    expect(keyAfter).toBeNull();

    // Storage cleared
    const stored = await memoryStorage.get(SESSION_STORAGE_KEY);
    expect(stored[SESSION_STORAGE_KEY]).toBeUndefined();
  });

  describe('State Restoration Across Service Worker Restart', () => {
    it('restores state to PAIRED_NO_PERMISSION when session valid but no permission granted', async () => {
      // Simulate persisted session in storage
      await memoryStorage.set({
        [SESSION_STORAGE_KEY]: {
          installationId: 'inst_restored_1',
          connectionId: 'conn_restored_1',
          clinicId: 'CLN-001',
          sessionToken: 'stk_valid',
          expiresAt: new Date(Date.now() + 100000).toISOString(),
          targetOrigin: 'http://localhost:4001',
          pairedAt: new Date().toISOString(),
        },
      });

      // Permission contains returns false
      (mockPermissionsApi.contains as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const freshFsm = new ConnectionFSM();
      const freshCoordinator = new PairingCoordinator({
        fsm: freshFsm,
        apiClient,
        storage: memoryStorage,
        permissionsApi: mockPermissionsApi,
      });

      const restoredRecord = await freshCoordinator.restoreState();
      expect(restoredRecord.state).toBe('PAIRED_NO_PERMISSION');
      expect(restoredRecord.connectionId).toBe('conn_restored_1');
      expect(freshFsm.getState()).toBe('PAIRED_NO_PERMISSION');
    });

    it('restores state to PROBING when session valid and permission already granted', async () => {
      await memoryStorage.set({
        [SESSION_STORAGE_KEY]: {
          installationId: 'inst_restored_2',
          connectionId: 'conn_restored_2',
          clinicId: 'CLN-001',
          sessionToken: 'stk_valid',
          expiresAt: new Date(Date.now() + 100000).toISOString(),
          targetOrigin: 'http://localhost:4001',
          pairedAt: new Date().toISOString(),
        },
      });

      // Permission contains returns true
      (mockPermissionsApi.contains as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const freshFsm = new ConnectionFSM();
      const freshCoordinator = new PairingCoordinator({
        fsm: freshFsm,
        apiClient,
        storage: memoryStorage,
        permissionsApi: mockPermissionsApi,
      });

      const restoredRecord = await freshCoordinator.restoreState();
      expect(restoredRecord.state).toBe('PROBING');
      expect(freshFsm.getState()).toBe('PROBING');
    });

    it('clears session and restores to UNPAIRED when stored session is expired', async () => {
      await memoryStorage.set({
        [SESSION_STORAGE_KEY]: {
          installationId: 'inst_expired',
          connectionId: 'conn_expired',
          clinicId: 'CLN-001',
          sessionToken: 'stk_expired',
          expiresAt: new Date(Date.now() - 5000).toISOString(), // expired
          targetOrigin: 'http://localhost:4001',
          pairedAt: new Date(Date.now() - 100000).toISOString(),
        },
      });

      const freshFsm = new ConnectionFSM();
      const freshCoordinator = new PairingCoordinator({
        fsm: freshFsm,
        apiClient,
        storage: memoryStorage,
        permissionsApi: mockPermissionsApi,
      });

      const restoredRecord = await freshCoordinator.restoreState();
      expect(restoredRecord.state).toBe('UNPAIRED');
      expect(freshFsm.getState()).toBe('UNPAIRED');

      const stored = await memoryStorage.get(SESSION_STORAGE_KEY);
      expect(stored[SESSION_STORAGE_KEY]).toBeUndefined();
    });

    it('transitions from PROBING down to PAIRED_NO_PERMISSION if host permission was removed externally', async () => {
      await memoryStorage.set({
        [SESSION_STORAGE_KEY]: {
          installationId: 'inst_restored_3',
          connectionId: 'conn_restored_3',
          clinicId: 'CLN-001',
          sessionToken: 'stk_valid',
          expiresAt: new Date(Date.now() + 100000).toISOString(),
          targetOrigin: 'http://localhost:4001',
          pairedAt: new Date().toISOString(),
        },
      });

      // Permission contains returns false
      (mockPermissionsApi.contains as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      // FSM currently in PROBING
      fsm.transition('PAIRING', { reason: 'pair' });
      fsm.transition('PAIRED_NO_PERMISSION', { reason: 'paired', targetOrigin: 'http://localhost:4001' });
      fsm.transition('PROBING', { reason: 'probed', targetOrigin: 'http://localhost:4001' });
      expect(fsm.getState()).toBe('PROBING');

      const record = await coordinator.restoreState();
      expect(record.state).toBe('PAIRED_NO_PERMISSION');
      expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');
    });
  });

  describe('Concurrency & Lease Coordination', () => {
    it('releases active leader lease on unpair', async () => {
      const releaseSpy = vi.spyOn(apiClient, 'releaseLease');

      await coordinator.pair('PAIR-TEST-123');
      coordinator.setActiveLease({
        connectionId: 'conn_coord_456',
        leaseId: 'lease_active_999',
        fencingToken: 42,
      });

      expect(coordinator.getActiveLease()).toBeDefined();

      await coordinator.unpair('User unpair with active lease');

      expect(releaseSpy).toHaveBeenCalledWith('conn_coord_456', 'lease_active_999');
      expect(coordinator.getActiveLease()).toBeNull();
    });

    it('rejects concurrent pairing attempts when handshake is inflight', async () => {
      // Delay mockFetch to keep pairing inflight
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      installationId: 'inst_slow',
                      connectionId: 'conn_slow',
                      clinicId: 'CLN-001',
                      sessionToken: 'stk_slow',
                      expiresAt: new Date(Date.now() + 3600000).toISOString(),
                      targetOrigin: 'http://localhost:4001',
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                  )
                ),
              50
            );
          })
      );

      const p1 = coordinator.pair('PAIR-CODE-1');
      await expect(coordinator.pair('PAIR-CODE-2')).rejects.toThrow(/already in progress/);
      await p1;
    });

    it('handles real-time host permission removal via handlePermissionsRemoved', async () => {
      await coordinator.pair('PAIR-TEST-123');
      await coordinator.grantHostPermission();
      expect(fsm.getState()).toBe('PROBING');

      // Unrelated origin removed -> no change
      await coordinator.handlePermissionsRemoved({ origins: ['https://other-site.com/*'] });
      expect(fsm.getState()).toBe('PROBING');

      // Exact CMS origin removed -> transitions to PAIRED_NO_PERMISSION
      await coordinator.handlePermissionsRemoved({ origins: ['http://localhost:4001/*'] });
      expect(fsm.getState()).toBe('PAIRED_NO_PERMISSION');
    });

    it('auto-recovers expired session token on restoreState and preserves pairing', async () => {
      await coordinator.pair('PAIR-TEST-123');

      // Expire session token in storage
      const session = await coordinator.getSession();
      expect(session).not.toBeNull();
      const expiredSession = {
        ...session!,
        expiresAt: new Date(Date.now() - 60000).toISOString(),
      };
      await memoryStorage.set({ [SESSION_STORAGE_KEY]: expiredSession });

      // Mock successful renewal response
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'ok',
            sessionToken: 'stk_renewed_on_startup',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      // Reset FSM to UNPAIRED simulating fresh SW startup
      const freshFsm = new ConnectionFSM();
      const freshCoordinator = new PairingCoordinator({
        fsm: freshFsm,
        apiClient,
        storage: memoryStorage,
        permissionsApi: mockPermissionsApi,
      });

      const restoredRecord = await freshCoordinator.restoreState();

      // State is restored to PAIRED_NO_PERMISSION (or PROBING) without dropping pairing!
      expect(restoredRecord.state).not.toBe('UNPAIRED');
      const updatedSession = await freshCoordinator.getSession();
      expect(updatedSession?.sessionToken).toBe('stk_renewed_on_startup');
      expect(freshCoordinator.apiClient.getSessionToken()).toBe('stk_renewed_on_startup');
    });
  });
});
