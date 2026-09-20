// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { BatchUploader } from '../../src/background/batch-uploader.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { DeduplicationCache } from '../../src/background/dedupe.js';
import { type SyncEvent } from '../../src/core/contracts/events.js';

describe('Batch Uploader (Phase 7)', () => {
  const sampleEvent: SyncEvent = {
    eventId: 'evt_test_1',
    entityType: 'patient',
    entityId: 'P-01',
    eventType: 'PATIENT_SYNCED',
    revision: 1,
    occurredAt: '2026-09-21T00:00:00Z',
    payload: { id: 'P-01' },
  };

  it('buffers events and automatically flushes when maxBatchSize is reached', async () => {
    const mockApiClient = new SyncApiClient();
    const sendBatchSpy = vi.spyOn(mockApiClient, 'sendEventBatch').mockResolvedValue({
      acknowledged: true,
      batchId: 'batch_test_1',
      processedCount: 2,
      checkpoint: 'chk_123',
    });

    const onAck = vi.fn();
    const uploader = new BatchUploader({
      apiClient: mockApiClient,
      installationId: 'inst_1',
      maxBatchSize: 2,
      onBatchAcknowledged: onAck,
    });

    await uploader.enqueue(sampleEvent);
    expect(sendBatchSpy).not.toHaveBeenCalled();
    expect(uploader.getPendingCount()).toBe(1);

    // Adding second event reaches maxBatchSize -> triggers flush
    const event2: SyncEvent = { ...sampleEvent, eventId: 'evt_test_2', entityId: 'P-02' };
    await uploader.enqueue(event2);

    expect(sendBatchSpy).toHaveBeenCalledTimes(1);
    expect(uploader.getPendingCount()).toBe(0);
    expect(onAck).toHaveBeenCalledWith([sampleEvent, event2], 'chk_123');
  });

  it('filters out duplicate events when dedupeCache is provided', async () => {
    const mockApiClient = new SyncApiClient();
    const dedupeCache = new DeduplicationCache();
    const uploader = new BatchUploader({
      apiClient: mockApiClient,
      installationId: 'inst_1',
      maxBatchSize: 10,
      dedupeCache,
    });

    // Record in dedupe cache
    dedupeCache.record('patient', 'P-01', 1, { id: 'P-01' });

    // Enqueue duplicate event
    await uploader.enqueue(sampleEvent);
    expect(uploader.getPendingCount()).toBe(0); // dropped as duplicate
  });

  it('re-queues events and does not advance cursor if Sync API rejects batch', async () => {
    const mockApiClient = new SyncApiClient();
    vi.spyOn(mockApiClient, 'sendEventBatch').mockRejectedValue(new Error('Sync API 500'));

    const onAck = vi.fn();
    const uploader = new BatchUploader({
      apiClient: mockApiClient,
      installationId: 'inst_1',
      maxBatchSize: 10,
      onBatchAcknowledged: onAck,
    });

    await uploader.enqueue(sampleEvent);
    expect(uploader.getPendingCount()).toBe(1);

    await expect(uploader.flush()).rejects.toThrow('Sync API 500');

    // Events must be retained in queue
    expect(uploader.getPendingCount()).toBe(1);
    expect(onAck).not.toHaveBeenCalled();
  });
});
