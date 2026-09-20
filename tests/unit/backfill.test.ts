// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackfillEngine, type StorageAdapter, BACKFILL_CHECKPOINT_KEY } from '../../src/background/backfill.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { LeaseCoordinator } from '../../src/background/lease-client.js';
import { BatchUploader } from '../../src/background/batch-uploader.js';
import { SyncApiClient } from '../../src/background/api-client.js';

describe('Checkpointed Backfill Engine (Phase 7)', () => {
  let fsm: ConnectionFSM;
  let apiClient: SyncApiClient;
  let leaseCoordinator: LeaseCoordinator;
  let batchUploader: BatchUploader;

  const createMockStorage = (): StorageAdapter & { store: Map<string, unknown> } => {
    const store = new Map<string, unknown>();
    return {
      store,
      get: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const res: Record<string, unknown> = {};
        for (const k of list) if (store.has(k)) res[k] = store.get(k);
        return res;
      },
      set: async (items) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      },
      remove: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) store.delete(k);
      },
    };
  };

  beforeEach(() => {
    fsm = new ConnectionFSM({ state: 'ACTIVE' });
    apiClient = new SyncApiClient();
    leaseCoordinator = new LeaseCoordinator({ apiClient });
    batchUploader = new BatchUploader({
      apiClient,
      installationId: 'inst_1',
      maxBatchSize: 50,
    });

    // Default mock: lease is held
    vi.spyOn(leaseCoordinator, 'hasActiveLease').mockReturnValue(true);
    // Default mock: Sync API batch uploader acknowledges batches
    vi.spyOn(apiClient, 'sendEventBatch').mockResolvedValue({
      acknowledged: true,
      batchId: 'batch_1',
      processedCount: 2,
      checkpoint: 'chk_1',
    });
  });

  it('advances checkpoint cursor ONLY upon verified server batch acknowledgment', async () => {
    const storage = createMockStorage();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'P-01', fullName: 'Patient 1', phone: '+60123456701' }],
        total: 10,
      }),
    } as Response);

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      pageSize: 1, // 1 record per page to test cursor increment
      storage,
      fetchFn: mockFetch,
    });

    const hasMore = await engine.step();
    expect(hasMore).toBe(true);

    const checkpoint = engine.getCheckpoint();
    expect(checkpoint.cursor).toBe(2);
    expect(checkpoint.processedCount).toBe(1);

    // Verify persisted in storage
    const stored = storage.store.get(BACKFILL_CHECKPOINT_KEY) as Record<string, unknown>;
    expect(stored.cursor).toBe(2);
    // Crucial AGENTS.md Rule 6: Zero raw PHI in storage
    expect(stored.fullName).toBeUndefined();
    expect(stored.phone).toBeUndefined();
  });

  it('resumes cleanly from persisted checkpoint across service worker restart', async () => {
    const storage = createMockStorage();
    // Simulate pre-existing checkpoint persisted before service worker termination
    await storage.set({
      [BACKFILL_CHECKPOINT_KEY]: {
        entityType: 'patient',
        cursor: 3,
        status: 'PAUSED',
        lastSyncTime: '2026-09-20T00:00:00Z',
        processedCount: 100,
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: 'P-101', fullName: 'Patient 101', phone: '+60123456701' }],
        total: 101,
      }),
    } as Response);

    // Fresh engine instance simulating SW restart
    const resumedEngine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      pageSize: 50,
      storage,
      fetchFn: mockFetch,
    });

    await resumedEngine.restoreCheckpoint();
    expect(resumedEngine.getCheckpoint().cursor).toBe(3);
    expect(resumedEngine.getCheckpoint().processedCount).toBe(100);

    await resumedEngine.step();

    // Verify page 3 was requested from CMS
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('page=3'),
      expect.anything()
    );
  });

  it('halts immediately when leader lease is not held', async () => {
    vi.spyOn(leaseCoordinator, 'hasActiveLease').mockReturnValue(false);
    const storage = createMockStorage();

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      storage,
    });

    await expect(engine.step()).rejects.toThrow('No active leader lease');
    expect(engine.getCheckpoint().status).toBe('PAUSED');
  });

  it('transitions connection FSM to REAUTH_REQUIRED when CMS responds with 401', async () => {
    const storage = createMockStorage();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'UNAUTHORIZED' }),
      headers: new Headers(),
    } as Response);

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      storage,
      fetchFn: mockFetch,
    });

    const hasMore = await engine.step();
    expect(hasMore).toBe(false);
    expect(fsm.getState()).toBe('REAUTH_REQUIRED');
    expect(engine.getCheckpoint().status).toBe('PAUSED');
    expect(engine.getCheckpoint().error).toBe('UNAUTHORIZED');
  });

  it('pauses and records retryAfterSeconds when CMS responds with 429 Rate Limit', async () => {
    const storage = createMockStorage();
    const headers = new Headers();
    headers.set('Retry-After', '45');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'RATE_LIMITED' }),
      headers,
    } as Response);

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      storage,
      fetchFn: mockFetch,
    });

    const hasMore = await engine.step();
    expect(hasMore).toBe(false);
    expect(engine.getCheckpoint().status).toBe('PAUSED');
    expect(engine.getCheckpoint().retryAfterSeconds).toBe(45);
  });

  it('pauses cleanly without advancing cursor on CMS 500 or network drop', async () => {
    const storage = createMockStorage();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'INTERNAL_ERROR' }),
      headers: new Headers(),
    } as Response);

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      storage,
      fetchFn: mockFetch,
    });

    const hasMore = await engine.step();
    expect(hasMore).toBe(false);
    expect(engine.getCheckpoint().status).toBe('PAUSED');
    // Cursor MUST remain 1 (never lost or prematurely incremented)
    expect(engine.getCheckpoint().cursor).toBe(1);
  });

  it('queries appointments with bounded date window parameters and updates lastSuccessfulSync', async () => {
    const storage = createMockStorage();
    // Start at appointment entityType
    await storage.set({
      [BACKFILL_CHECKPOINT_KEY]: {
        entityType: 'appointment',
        cursor: 1,
        status: 'IDLE',
        lastSyncTime: '2026-09-20T00:00:00Z',
        lastSuccessfulSync: '2026-09-20T00:00:00Z',
        processedCount: 0,
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 'APT-01',
            patientId: 'P-01',
            providerId: 'DOC-01',
            serviceId: 'SRV-01',
            startTime: '2026-10-01T09:00:00+08:00',
            endTime: '2026-10-01T09:15:00+08:00',
            status: 'booked',
            rev: 1,
          },
        ],
        total: 1,
      }),
    } as Response);

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      pageSize: 50,
      appointmentWindowDaysPast: 15,
      appointmentWindowDaysFuture: 45,
      storage,
      fetchFn: mockFetch,
    });

    await engine.restoreCheckpoint();
    const hasMore = await engine.step();
    expect(hasMore).toBe(false); // only 1 record, completed

    // Verify appointment URL was bounded with startDate and endDate
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/appointments');
    expect(calledUrl).toContain('startDate=');
    expect(calledUrl).toContain('endDate=');

    const checkpoint = engine.getCheckpoint();
    expect(checkpoint.status).toBe('COMPLETED');
    expect(checkpoint.lastSuccessfulSync).toBeDefined();
    expect(checkpoint.lastSyncTime).toBe(checkpoint.lastSuccessfulSync);
  });
});
