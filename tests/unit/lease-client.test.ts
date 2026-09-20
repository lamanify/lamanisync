// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseCoordinator } from '../../src/background/lease-client.js';
import { SyncApiClient } from '../../src/background/api-client.js';

describe('Leader Lease Coordinator (Phase 7)', () => {
  let mockApiClient: SyncApiClient;
  let coordinator: LeaseCoordinator;

  beforeEach(() => {
    mockApiClient = new SyncApiClient();
    coordinator = new LeaseCoordinator({
      apiClient: mockApiClient,
      defaultDurationSeconds: 10,
    });
  });

  it('successfully acquires a leader lease with a monotonic fencing token', async () => {
    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValue({
      status: 'GRANTED',
      leaseId: 'lease_mock_1',
      fencingToken: 1,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });

    const acquired = await coordinator.acquire('conn_1', 'inst_1', 10);
    expect(acquired).toBe(true);
    expect(coordinator.hasActiveLease()).toBe(true);
    expect(coordinator.getFencingToken()).toBe(1);

    const lease = coordinator.getActiveLease();
    expect(lease).not.toBeNull();
    expect(lease?.leaseId).toBe('lease_mock_1');
    expect(lease?.connectionId).toBe('conn_1');
  });

  it('rejects stale or non-monotonic fencing tokens', async () => {
    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValueOnce({
      status: 'GRANTED',
      leaseId: 'lease_mock_5',
      fencingToken: 5,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });

    await coordinator.acquire('conn_1', 'inst_1', 10);
    expect(coordinator.getFencingToken()).toBe(5);

    // Second acquire returns a lower or equal token (split-brain attack / replay)
    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValueOnce({
      status: 'GRANTED',
      leaseId: 'lease_mock_4',
      fencingToken: 4,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });

    const secondAcquire = await coordinator.acquire('conn_1', 'inst_1', 10);
    expect(secondAcquire).toBe(false);
    expect(coordinator.hasActiveLease()).toBe(false);
  });

  it('detects lease expiration based on local wall clock and fires onLeaseLost', async () => {
    const expiredIso = new Date(Date.now() - 1000).toISOString();
    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValue({
      status: 'GRANTED',
      leaseId: 'lease_mock_1',
      fencingToken: 1,
      expiresAt: expiredIso,
    });

    const lostCallback = vi.fn();
    coordinator.onLeaseLost(lostCallback);

    await coordinator.acquire('conn_1', 'inst_1', 1);
    expect(coordinator.hasActiveLease()).toBe(false);
    expect(lostCallback).toHaveBeenCalled();
  });

  it('successfully renews an active lease extending expiry', async () => {
    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValue({
      status: 'GRANTED',
      leaseId: 'lease_mock_1',
      fencingToken: 1,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });

    await coordinator.acquire('conn_1', 'inst_1', 10);

    const renewedExpiry = new Date(Date.now() + 20000).toISOString();
    vi.spyOn(mockApiClient, 'renewLease').mockResolvedValue({
      status: 'RENEWED',
      leaseId: 'lease_mock_1',
      fencingToken: 1,
      expiresAt: renewedExpiry,
    });

    const renewed = await coordinator.renew(20);
    expect(renewed).toBe(true);
    expect(coordinator.getActiveLease()?.expiresAt).toBe(renewedExpiry);
  });

  it('immediately fires onLeaseLost callback when renewal is rejected or lost', async () => {
    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValue({
      status: 'GRANTED',
      leaseId: 'lease_mock_1',
      fencingToken: 1,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });

    await coordinator.acquire('conn_1', 'inst_1', 10);

    const lostCallback = vi.fn();
    coordinator.onLeaseLost(lostCallback);

    // Simulate server renewal rejection (another leader took over)
    vi.spyOn(mockApiClient, 'renewLease').mockRejectedValue(new Error('Lease lost'));

    // Advance clock past expiration
    (coordinator as unknown as { currentLease: { expiresAtMs: number } }).currentLease.expiresAtMs = Date.now() - 100;

    const renewed = await coordinator.renew();
    expect(renewed).toBe(false);
    expect(coordinator.hasActiveLease()).toBe(false);
    expect(lostCallback).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });

  it('cleanly releases lease on demand and notifies listeners', async () => {
    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValue({
      status: 'GRANTED',
      leaseId: 'lease_mock_1',
      fencingToken: 1,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });
    vi.spyOn(mockApiClient, 'releaseLease').mockResolvedValue({ status: 'RELEASED' });

    const lostCallback = vi.fn();
    coordinator.onLeaseLost(lostCallback);

    await coordinator.acquire('conn_1', 'inst_1', 10);
    expect(coordinator.hasActiveLease()).toBe(true);

    await coordinator.release();
    expect(coordinator.hasActiveLease()).toBe(false);
    expect(lostCallback).toHaveBeenCalledWith(expect.stringContaining('explicitly released'));
  });

  it('persists lease to storage and restores cleanly across service worker restart', async () => {
    const memStore = new Map<string, unknown>();
    const mockStorage = {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const res: Record<string, unknown> = {};
        for (const k of list) if (memStore.has(k)) res[k] = memStore.get(k);
        return res;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) memStore.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) memStore.delete(k);
      },
    };

    const coord1 = new LeaseCoordinator({
      apiClient: mockApiClient,
      storage: mockStorage,
      defaultDurationSeconds: 30,
    });

    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValue({
      status: 'GRANTED',
      leaseId: 'lease_persist_1',
      fencingToken: 7,
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });

    await coord1.acquire('conn_1', 'inst_1', 30);
    expect(coord1.hasActiveLease()).toBe(true);
    expect(coord1.getFencingToken()).toBe(7);

    // Simulate SW shutdown / restart: construct new LeaseCoordinator with same storage
    const coord2 = new LeaseCoordinator({
      apiClient: mockApiClient,
      storage: mockStorage,
      defaultDurationSeconds: 30,
    });

    expect(coord2.hasActiveLease()).toBe(false);
    const restored = await coord2.restore();
    expect(restored).not.toBeNull();
    expect(restored?.leaseId).toBe('lease_persist_1');
    expect(coord2.hasActiveLease()).toBe(true);
    expect(coord2.getFencingToken()).toBe(7);

    coord1.destroy();
    coord2.destroy();
  });

  it('detects expired lease on restore and cleans up storage', async () => {
    const memStore = new Map<string, unknown>();
    const mockStorage = {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const res: Record<string, unknown> = {};
        for (const k of list) if (memStore.has(k)) res[k] = memStore.get(k);
        return res;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) memStore.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) memStore.delete(k);
      },
    };

    // Stored lease already expired in past
    memStore.set('lamanisync_active_lease', {
      lease: {
        connectionId: 'conn_1',
        installationId: 'inst_1',
        leaseId: 'lease_old',
        fencingToken: 3,
        expiresAt: new Date(Date.now() - 5000).toISOString(),
        expiresAtMs: Date.now() - 5000,
        acquiredAt: Date.now() - 35000,
      },
      highestFencingToken: 3,
    });

    const coord = new LeaseCoordinator({
      apiClient: mockApiClient,
      storage: mockStorage,
    });

    const lostFn = vi.fn();
    coord.onLeaseLost(lostFn);

    const restored = await coord.restore();
    expect(restored).toBeNull();
    expect(coord.hasActiveLease()).toBe(false);
    expect(coord.getFencingToken()).toBe(null);
    expect(lostFn).toHaveBeenCalledWith(expect.stringContaining('suspended'));
    expect(memStore.has('lamanisync_active_lease')).toBe(false);
  });

  it('schedules and clears chrome.alarms when chrome.alarms is available', async () => {
    const createAlarmSpy = vi.fn();
    const clearAlarmSpy = vi.fn();

    // Mock chrome.alarms
    (globalThis as unknown as { chrome: unknown }).chrome = {
      alarms: {
        create: createAlarmSpy,
        clear: clearAlarmSpy,
      },
    };

    vi.spyOn(mockApiClient, 'acquireLease').mockResolvedValue({
      status: 'GRANTED',
      leaseId: 'lease_alarm_1',
      fencingToken: 1,
      expiresAt: new Date(Date.now() + 20000).toISOString(),
    });
    vi.spyOn(mockApiClient, 'releaseLease').mockResolvedValue({ status: 'RELEASED' });

    const coord = new LeaseCoordinator({ apiClient: mockApiClient });
    await coord.acquire('conn_1', 'inst_1', 20);

    expect(createAlarmSpy).toHaveBeenCalledWith('lease_renewal', expect.objectContaining({ when: expect.any(Number) }));

    await coord.release();
    expect(clearAlarmSpy).toHaveBeenCalledWith('lease_renewal');

    coord.destroy();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });
});
