// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setIndexedDbFactory } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';
import { SESSION_STORAGE_KEY } from '../../src/background/pairing.js';

describe('Service Worker Lifecycle & Message Handling', () => {
  let messageListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => boolean>;
  let permissionsRemovedListeners: Array<(perms: unknown) => void>;
  let storageMap: Map<string, unknown>;

  beforeEach(() => {
    messageListeners = [];
    permissionsRemovedListeners = [];
    storageMap = new Map();

    const mockIdb = createMockIDBFactory();
    setIndexedDbFactory(mockIdb);
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = mockIdb;

    // Mock chrome globals
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        getManifest: () => ({ version: '0.1.0', name: 'LamaniSync Dev' }),
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: {
          addListener: vi.fn((cb) => messageListeners.push(cb)),
        },
      },
      storage: {
        local: {
          get: vi.fn(async (keys) => {
            const keyArr = Array.isArray(keys) ? keys : [keys];
            const result: Record<string, unknown> = {};
            for (const k of keyArr) {
              if (storageMap.has(k)) result[k] = storageMap.get(k);
            }
            return result;
          }),
          set: vi.fn(async (items) => {
            for (const [k, v] of Object.entries(items)) storageMap.set(k, v);
          }),
          remove: vi.fn(async (keys) => {
            const keyArr = Array.isArray(keys) ? keys : [keys];
            for (const k of keyArr) storageMap.delete(k);
          }),
        },
      },
      permissions: {
        request: vi.fn().mockResolvedValue(true),
        contains: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
        onRemoved: {
          addListener: vi.fn((cb) => permissionsRemovedListeners.push(cb)),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores state from storage upon receiving GET_CONNECTION_STATE after ephemeral SW restart', async () => {
    // Seed storage with a paired session
    storageMap.set(SESSION_STORAGE_KEY, {
      installationId: 'inst_seed_1',
      connectionId: 'conn_seed_1',
      clinicId: 'CLN-001',
      sessionToken: 'stk_seed_1',
      expiresAt: new Date(Date.now() + 100000).toISOString(),
      targetOrigin: 'http://localhost:4001',
      pairedAt: new Date().toISOString(),
    });

    // Re-import service-worker module to simulate fresh SW execution context
    vi.resetModules();
    await import('../../src/background/service-worker.js');

    expect(messageListeners.length).toBeGreaterThan(0);
    const handler = messageListeners[0];

    const response = await new Promise<{ record: { state: string; connectionId?: string } }>((resolve) => {
      handler({ type: 'GET_CONNECTION_STATE' }, {}, (res) => resolve(res as { record: { state: string } }));
    });

    // Correctly restores PROBING because permissions.contains returns true
    expect(response.record.state).toBe('PROBING');
    expect(response.record.connectionId).toBe('conn_seed_1');
  });

  it('routes PAIR, GRANT_PERMISSION_RESULT, and UNPAIR messages through coordinator', async () => {
    // Mock fetch for pairing handshake
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/pair')) {
        return new Response(
          JSON.stringify({
            installationId: 'inst_sw_test',
            connectionId: 'conn_sw_test',
            clinicId: 'CLN-001',
            sessionToken: 'stk_sw_test',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            targetOrigin: 'http://localhost:4001',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/revoke')) {
        return new Response(JSON.stringify({ status: 'revoked' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    vi.resetModules();
    const sw = await import('../../src/background/service-worker.js');
    const handler = messageListeners[messageListeners.length - 1];

    // 1. Send PAIR message
    const pairRes = await new Promise<{ success: boolean; record: { state: string }; error?: string }>((resolve) => {
      handler({ type: 'PAIR', pairingCode: 'PAIR-SW-123' }, {}, (res) => resolve(res as { success: boolean; record: { state: string }; error?: string }));
    });

    expect(pairRes.success).toBe(true);
    expect(pairRes.record.state).toBe('PAIRED_NO_PERMISSION');
    expect(sw.fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    // 2. Send GRANT_PERMISSION_RESULT message
    const grantRes = await new Promise<{ success: boolean; record: { state: string } }>((resolve) => {
      handler({ type: 'GRANT_PERMISSION_RESULT', granted: true, targetOrigin: 'http://localhost:4001' }, {}, (res) => resolve(res as { success: boolean; record: { state: string } }));
    });

    expect(grantRes.success).toBe(true);
    expect(grantRes.record.state).toBe('PROBING');
    expect(sw.fsm.getState()).toBe('PROBING');

    // 3. Trigger chrome.permissions.onRemoved
    expect(permissionsRemovedListeners.length).toBeGreaterThan(0);
    const permHandler = permissionsRemovedListeners[permissionsRemovedListeners.length - 1];
    await permHandler({ origins: ['http://localhost:4001/*'] });
    expect(sw.fsm.getState()).toBe('PAIRED_NO_PERMISSION');

    // 4. Send UNPAIR message
    const unpairRes = await new Promise<{ success: boolean; record: { state: string } }>((resolve) => {
      handler({ type: 'UNPAIR', reason: 'User test unpair' }, {}, (res) => resolve(res as { success: boolean; record: { state: string } }));
    });

    expect(unpairRes.success).toBe(true);
    expect(unpairRes.record.state).toBe('UNPAIRED');
    expect(sw.fsm.getState()).toBe('UNPAIRED');
  });
});
