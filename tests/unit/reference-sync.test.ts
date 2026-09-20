// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  ReferenceSyncManager,
  type StorageAdapter,
  REFERENCE_STORAGE_KEY,
} from '../../src/background/reference-sync.js';

describe('Reference Data Ingestion & Cache (Phase 7)', () => {
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

  it('ingests providers, services, and locations into memory and storage', async () => {
    const storage = createMockStorage();
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/reference/providers')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'DOC-01', fullName: 'Dr. Siti', specialty: 'GP', active: true }],
          }),
        } as Response;
      }
      if (url.includes('/api/reference/services')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'SRV-01', name: 'Consultation', durationMinutes: 15, defaultPrice: 60 }],
          }),
        } as Response;
      }
      if (url.includes('/api/reference/locations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'LOC-01', name: 'Room 1', roomType: 'clinical' }],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const manager = new ReferenceSyncManager({
      targetOrigin: 'http://localhost:4001',
      storage,
      fetchFn: mockFetch,
    });

    const snapshot = await manager.sync();

    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.locations).toHaveLength(1);

    // In-memory lookups
    expect(manager.getProvider('DOC-01')?.fullName).toBe('Dr. Siti');
    expect(manager.getService('SRV-01')?.name).toBe('Consultation');
    expect(manager.getLocation('LOC-01')?.roomType).toBe('clinical');

    // Persisted in storage
    expect(storage.store.has(REFERENCE_STORAGE_KEY)).toBe(true);
  });

  it('restores reference cache cleanly from local storage across worker restarts', async () => {
    const storage = createMockStorage();
    const persistedSnapshot = {
      providers: [{ id: 'DOC-02', fullName: 'Dr. Tan', active: true }],
      services: [{ id: 'SRV-02', name: 'Scaling', durationMinutes: 30 }],
      locations: [{ id: 'LOC-02', name: 'Dental Suite A' }],
      syncedAt: '2026-09-21T00:00:00Z',
    };
    await storage.set({ [REFERENCE_STORAGE_KEY]: persistedSnapshot });

    const freshManager = new ReferenceSyncManager({
      targetOrigin: 'http://localhost:4001',
      storage,
    });

    const restored = await freshManager.restore();
    expect(restored).not.toBeNull();
    expect(freshManager.getProvider('DOC-02')?.fullName).toBe('Dr. Tan');
    expect(freshManager.getService('SRV-02')?.durationMinutes).toBe(30);
    expect(freshManager.getLocation('LOC-02')?.name).toBe('Dental Suite A');
  });
});
