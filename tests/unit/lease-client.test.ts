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
});
