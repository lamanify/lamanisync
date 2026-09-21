// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TokenManager } from '../../src/background/token-manager.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { SESSION_STORAGE_KEY, type StorageAdapter } from '../../src/background/pairing.js';
import { setIndexedDbFactory } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';
import { LamaniError } from '../../src/core/errors.js';

function createMockStorage(initialData: Record<string, unknown> = {}): StorageAdapter {
  const store = new Map<string, unknown>(Object.entries(initialData));
  return {
    get: async (keys) => {
      const result: Record<string, unknown> = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        if (store.has(k)) {
          result[k] = store.get(k);
        }
      }
      return result;
    },
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, v);
      }
    },
    remove: async (keys) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        store.delete(k);
      }
    },
  };
}

describe('Session Token Manager (Phase 10)', () => {
  let mockStorage: StorageAdapter;
  let apiClient: SyncApiClient;
  let fsm: ConnectionFSM;
  let tokenManager: TokenManager;

  const initialSession = {
    installationId: 'inst_test_123',
    connectionId: 'conn_test_456',
    clinicId: 'CLN-001',
    sessionToken: 'stk_initial_001',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour in future
    targetOrigin: 'http://localhost:4001',
    pairedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    setIndexedDbFactory(createMockIDBFactory());
    mockStorage = createMockStorage({
      [SESSION_STORAGE_KEY]: initialSession,
    });
    fsm = new ConnectionFSM({ state: 'ACTIVE' });
    apiClient = new SyncApiClient({ sessionToken: initialSession.sessionToken });
    tokenManager = new TokenManager({
      apiClient,
      storage: mockStorage,
      fsm,
      renewalThresholdMs: 5 * 60 * 1000, // 5 min
    });
  });

  it('determines expiration and renewal need accurately', () => {
    const now = Date.now();

    // Expired 1 second ago
    expect(tokenManager.isTokenExpired(new Date(now - 1000).toISOString(), now)).toBe(true);

    // Valid for 10 minutes (above 5 min threshold)
    const valid10m = new Date(now + 10 * 60 * 1000).toISOString();
    expect(tokenManager.isTokenExpired(valid10m, now)).toBe(false);
    expect(tokenManager.needsRenewal(valid10m, now)).toBe(false);

    // Valid for 3 minutes (below 5 min threshold)
    const valid3m = new Date(now + 3 * 60 * 1000).toISOString();
    expect(tokenManager.isTokenExpired(valid3m, now)).toBe(false);
    expect(tokenManager.needsRenewal(valid3m, now)).toBe(true);
  });

  it('proactively renews token and updates storage and apiClient', async () => {
    const renewedExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          sessionToken: 'stk_renewed_999',
          expiresAt: renewedExpiry,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    apiClient.setFetchFn(mockFetch as unknown as typeof fetch);

    const renewed = await tokenManager.renewToken();

    expect(renewed.sessionToken).toBe('stk_renewed_999');
    expect(renewed.expiresAt).toBe(renewedExpiry);
    expect(apiClient.getSessionToken()).toBe('stk_renewed_999');

    // Storage record was updated
    const stored = await tokenManager.getStoredSession();
    expect(stored?.sessionToken).toBe('stk_renewed_999');
  });

  it('deduplicates concurrent renewal requests into a single network call', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          status: 'ok',
          sessionToken: 'stk_renewed_concurrent',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    apiClient.setFetchFn(mockFetch as unknown as typeof fetch);

    const [res1, res2, res3] = await Promise.all([
      tokenManager.renewToken(),
      tokenManager.renewToken(),
      tokenManager.renewToken(),
    ]);

    expect(callCount).toBe(1);
    expect(res1.sessionToken).toBe('stk_renewed_concurrent');
    expect(res2.sessionToken).toBe('stk_renewed_concurrent');
    expect(res3.sessionToken).toBe('stk_renewed_concurrent');
  });

  it('auto-recovers from expired token via handleTokenExpired', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          sessionToken: 'stk_recovered_401',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    apiClient.setFetchFn(mockFetch as unknown as typeof fetch);

    const recovered = await tokenManager.handleTokenExpired();
    expect(recovered).toBe(true);
    expect(apiClient.getSessionToken()).toBe('stk_recovered_401');
  });

  it('transitions FSM to UNPAIRED and purges session when token recovery is rejected with 401', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'UNAUTHORIZED',
          message: 'Installation revoked by server',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    );
    apiClient.setFetchFn(mockFetch as unknown as typeof fetch);

    const recovered = await tokenManager.handleTokenExpired();
    expect(recovered).toBe(false);
    expect(fsm.getState()).toBe('UNPAIRED');
    expect(apiClient.getSessionToken()).toBeNull();

    const stored = await tokenManager.getStoredSession();
    expect(stored).toBeNull();
  });

  it('throws NOT_PAIRED if attempting to renew when no session exists', async () => {
    await mockStorage.remove(SESSION_STORAGE_KEY);
    await expect(tokenManager.renewToken()).rejects.toThrow(LamaniError);
  });

  it('omits Bearer Authorization header when calling renewSessionToken', async () => {
    let capturedAuth: string | null = null;
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      const headers = new Headers(init.headers);
      capturedAuth = headers.get('authorization');
      return new Response(
        JSON.stringify({
          status: 'ok',
          sessionToken: 'stk_renewed_clean',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    apiClient.setFetchFn(mockFetch as unknown as typeof fetch);

    await tokenManager.renewToken();
    expect(capturedAuth).toBeNull();
  });
});
