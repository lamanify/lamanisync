/**
 * Batch Uploader (Phase 7)
 * Buffers normalized SyncEvents and transmits signed batches to POST /v1/sync/events/batch.
 * Strictly adheres to AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, or secrets.
 * Rule 7: Ephemeral SW safe; flush and cursor advancement only on verified server HTTP 200.
 */

import { type SyncEvent } from '../core/contracts/events.js';
import { SyncApiClient } from './api-client.js';
import { DeduplicationCache } from './dedupe.js';
import { LamaniError } from '../core/errors.js';

export interface BatchUploaderOptions {
  apiClient: SyncApiClient;
  installationId: string;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  dedupeCache?: DeduplicationCache;
  onBatchAcknowledged?: (events: SyncEvent[], checkpoint: string) => Promise<void> | void;
}

export interface BatchUploadResult {
  acknowledged: boolean;
  batchId: string;
  processedCount: number;
  checkpoint?: string;
  events: SyncEvent[];
}

export class BatchUploader {
  private apiClient: SyncApiClient;
  private installationId: string;
  private maxBatchSize: number;
  private flushIntervalMs: number;
  private dedupeCache?: DeduplicationCache;
  private onBatchAcknowledged?: (events: SyncEvent[], checkpoint: string) => Promise<void> | void;

  private queue: SyncEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing: boolean = false;

  constructor(options: BatchUploaderOptions) {
    this.apiClient = options.apiClient;
    this.installationId = options.installationId;
    this.maxBatchSize = options.maxBatchSize || 50;
    this.flushIntervalMs = options.flushIntervalMs || 5000;
    this.dedupeCache = options.dedupeCache;
    this.onBatchAcknowledged = options.onBatchAcknowledged;
  }

  setInstallationId(id: string): void {
    this.installationId = id;
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  /**
   * Enqueues one or more SyncEvents.
   * If deduplication cache is configured, drops duplicate events before enqueueing (unless force is true).
   * Automatically flushes if batch size reaches maxBatchSize.
   */
  async enqueue(
    eventOrEvents: SyncEvent | SyncEvent[],
    options: { force?: boolean } = {}
  ): Promise<void> {
    const list = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];

    for (const evt of list) {
      if (this.dedupeCache && !options.force) {
        const isDup = this.dedupeCache.isDuplicate(
          evt.entityType,
          evt.entityId,
          evt.revision,
          evt.payload
        );
        if (isDup) {
          continue; // Skip duplicate event
        }
      }
      this.queue.push(evt);
    }

    if (this.queue.length >= this.maxBatchSize) {
      await this.flush();
    } else if (this.queue.length > 0 && !this.flushTimer && this.flushIntervalMs > 0) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush().catch((err) => {
          console.warn('[BatchUploader] Automatic flush error:', err);
        });
      }, this.flushIntervalMs);
    }
  }

  /**
   * Flushes current queued events to Sync API in a single signed batch.
   * Advances local checkpoint cursor ONLY upon server acknowledgment (HTTP 200).
   */
  async flush(): Promise<BatchUploadResult | null> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0 || this.isFlushing) {
      return null;
    }

    this.isFlushing = true;
    const batchEvents = this.queue.splice(0, this.maxBatchSize);
    const batchId = `batch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    try {
      const response = await this.apiClient.sendEventBatch(
        this.installationId,
        batchEvents,
        batchId
      );

      if (!response || !response.acknowledged) {
        // Re-queue events at the beginning of the queue
        this.queue.unshift(...batchEvents);
        throw new LamaniError('Sync API did not acknowledge batch', 'BATCH_NOT_ACKNOWLEDGED');
      }

      // Record successfully ingested events in dedupe cache
      if (this.dedupeCache) {
        for (const evt of batchEvents) {
          this.dedupeCache.record(
            evt.entityType,
            evt.entityId,
            evt.revision,
            evt.payload
          );
        }
      }

      // Notify callback ONLY after verified server acknowledgment
      if (this.onBatchAcknowledged) {
        await this.onBatchAcknowledged(batchEvents, response.checkpoint);
      }

      return {
        acknowledged: true,
        batchId,
        processedCount: response.processedCount,
        checkpoint: response.checkpoint,
        events: batchEvents,
      };
    } catch (err) {
      // Re-queue on failure so events are not lost
      this.queue.unshift(...batchEvents);
      throw err;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Clears the in-memory queue.
   */
  clear(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = [];
  }
}
