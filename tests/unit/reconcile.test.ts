// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReconcileWorker } from '../../src/background/reconcile.js';
import { LeaseCoordinator } from '../../src/background/lease-client.js';
import { BatchUploader } from '../../src/background/batch-uploader.js';
import { SyncApiClient } from '../../src/background/api-client.js';

describe('Reconciliation Worker (Phase 7)', () => {
  let apiClient: SyncApiClient;
  let leaseCoordinator: LeaseCoordinator;
  let batchUploader: BatchUploader;

  beforeEach(() => {
    apiClient = new SyncApiClient();
    leaseCoordinator = new LeaseCoordinator({ apiClient });
    batchUploader = new BatchUploader({
      apiClient,
      installationId: 'inst_1',
    });

    vi.spyOn(leaseCoordinator, 'hasActiveLease').mockReturnValue(true);
  });

  it('skips reconciliation when leader lease is not held', async () => {
    vi.spyOn(leaseCoordinator, 'hasActiveLease').mockReturnValue(false);

    const worker = new ReconcileWorker({
      leaseCoordinator,
      apiClient,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
    });

    const result = await worker.runReconciliation();
    expect(result.status).toBe('SKIPPED');
    expect(result.repairedCount).toBe(0);
  });

  it('detects and repairs missed patient and appointment records', async () => {
    // Sync API reports only P-01 and APT-01 at rev 1
    vi.spyOn(apiClient, 'getReconcileSummary').mockResolvedValue({
      connectionId: 'conn_1',
      totalEvents: 2,
      entityCounts: { patient: 1, appointment: 1 },
      knownEntityIds: {
        patient: ['P-01'],
        appointment: ['APT-01'],
      },
      entityRevisions: {
        'APT-01': 1,
      },
    });

    // CMS has P-01, P-02 (P-02 was missed!) and APT-01 at rev 2 (rev 2 was missed!)
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/patients')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'P-01', fullName: 'Patient 1', phone: '+60123456701' },
              { id: 'P-02', fullName: 'Patient 2', phone: '+60123456702' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/appointments')) {
        return {
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
                rev: 2, // higher revision than known 1
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const enqueueSpy = vi.spyOn(batchUploader, 'enqueue').mockResolvedValue();
    const flushSpy = vi.spyOn(batchUploader, 'flush').mockResolvedValue({
      acknowledged: true,
      batchId: 'batch_rep_1',
      processedCount: 2,
      events: [],
    });

    const worker = new ReconcileWorker({
      leaseCoordinator,
      apiClient,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      fetchFn: mockFetch,
    });

    const result = await worker.runReconciliation();

    expect(result.status).toBe('REPAIRED');
    expect(result.repairedCount).toBe(2);
    expect(result.repairedIds).toEqual(['P-02', 'APT-01']);
    expect(enqueueSpy).toHaveBeenCalled();
    expect(flushSpy).toHaveBeenCalled();
  });

  it('returns OK status when local and server state are in sync', async () => {
    vi.spyOn(apiClient, 'getReconcileSummary').mockResolvedValue({
      connectionId: 'conn_1',
      totalEvents: 1,
      entityCounts: { patient: 1, appointment: 0 },
      knownEntityIds: {
        patient: ['P-01'],
        appointment: [],
      },
      entityRevisions: {},
    });

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/patients')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'P-01', fullName: 'Patient 1', phone: '+60123456701' }],
          }),
        } as Response;
      }
      if (url.includes('/api/appointments')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const worker = new ReconcileWorker({
      leaseCoordinator,
      apiClient,
      batchUploader,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      fetchFn: mockFetch,
    });

    const result = await worker.runReconciliation();
    expect(result.status).toBe('OK');
    expect(result.repairedCount).toBe(0);
  });
});
