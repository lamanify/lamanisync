/**
 * Checkpointed Backfill Engine (Phase 7)
 * Orchestrates paginated historical backfill for patients and bounded appointments.
 * Strictly adheres to AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, or secrets.
 * Rule 6: Zero raw PHI stored in chrome.storage.local (checkpoints contain only numeric cursors and timestamps).
 * Rule 7: Ephemeral SW safe; survives suspensions and browser restarts by loading persisted checkpoint.
 * Rule 9: Runtime validation of all network inputs.
 */

import { ConnectionFSM } from './connection-fsm.js';
import { LeaseCoordinator } from './lease-client.js';
import { BatchUploader } from './batch-uploader.js';
import {
  normalizePatientSyncEvent,
  normalizeAppointmentSyncEvent,
} from '../core/event-normalizer.js';
import { LamaniError } from '../core/errors.js';

export const BACKFILL_CHECKPOINT_KEY = 'lamanisync_backfill_checkpoint';

export interface BackfillCheckpoint {
  entityType: 'patient' | 'appointment';
  cursor: number;
  status: 'IDLE' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'ERROR';
  lastSyncTime: string;
  lastSuccessfulSync?: string;
  processedCount: number;
  totalRecords?: number;
  error?: string;
  retryAfterSeconds?: number;
}

export interface StorageAdapter {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function resolveStorage(custom?: StorageAdapter): StorageAdapter {
  if (custom) return custom;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return {
      get: (keys) => chrome.storage.local.get(keys),
      set: (items) => chrome.storage.local.set(items),
      remove: (keys) => chrome.storage.local.remove(keys),
    };
  }
  const mem = new Map<string, unknown>();
  return {
    get: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const res: Record<string, unknown> = {};
      for (const k of list) {
        if (mem.has(k)) res[k] = mem.get(k);
      }
      return res;
    },
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) mem.set(k, v);
    },
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) mem.delete(k);
    },
  };
}

export interface BackfillEngineOptions {
  leaseCoordinator: LeaseCoordinator;
  fsm: ConnectionFSM;
  batchUploader: BatchUploader;
  targetOrigin: string;
  connectionId: string;
  installationId: string;
  pageSize?: number;
  appointmentWindowDaysPast?: number;
  appointmentWindowDaysFuture?: number;
  storage?: StorageAdapter;
  fetchFn?: typeof fetch;
}

export class BackfillEngine {
  private leaseCoordinator: LeaseCoordinator;
  private fsm: ConnectionFSM;
  private batchUploader: BatchUploader;
  private targetOrigin: string;
  private connectionId: string;
  private installationId: string;
  private pageSize: number;
  private appointmentWindowDaysPast: number;
  private appointmentWindowDaysFuture: number;
  private storage: StorageAdapter;
  private fetchFn: typeof fetch;

  private checkpoint: BackfillCheckpoint = {
    entityType: 'patient',
    cursor: 1,
    status: 'IDLE',
    lastSyncTime: new Date().toISOString(),
    lastSuccessfulSync: new Date().toISOString(),
    processedCount: 0,
  };

  private isRunning: boolean = false;

  constructor(options: BackfillEngineOptions) {
    this.leaseCoordinator = options.leaseCoordinator;
    this.fsm = options.fsm;
    this.batchUploader = options.batchUploader;
    this.targetOrigin = options.targetOrigin.replace(/\/$/, '');
    this.connectionId = options.connectionId;
    this.installationId = options.installationId;
    this.pageSize = options.pageSize || 50;
    this.appointmentWindowDaysPast = options.appointmentWindowDaysPast ?? 30;
    this.appointmentWindowDaysFuture = options.appointmentWindowDaysFuture ?? 90;
    this.storage = resolveStorage(options.storage);
    this.fetchFn = options.fetchFn || ((...args) => globalThis.fetch(...args));

    // Register lease loss listener to immediately pause backfill
    this.leaseCoordinator.onLeaseLost((reason) => {
      if (this.isRunning || this.checkpoint.status === 'IN_PROGRESS') {
        this.pause(`Leader lease lost: ${reason}`);
      }
    });
  }

  getCheckpoint(): Readonly<BackfillCheckpoint> {
    return Object.freeze({ ...this.checkpoint });
  }

  /**
   * Restores checkpoint state from storage across worker restarts.
   */
  async restoreCheckpoint(): Promise<BackfillCheckpoint | null> {
    const data = await this.storage.get(BACKFILL_CHECKPOINT_KEY);
    const raw = data[BACKFILL_CHECKPOINT_KEY] as BackfillCheckpoint | undefined;

    if (raw && (raw.entityType === 'patient' || raw.entityType === 'appointment')) {
      const lastTime = raw.lastSyncTime || raw.lastSuccessfulSync || new Date().toISOString();
      this.checkpoint = {
        entityType: raw.entityType,
        cursor: Number.isInteger(raw.cursor) ? raw.cursor : 1,
        status: raw.status || 'IDLE',
        lastSyncTime: lastTime,
        lastSuccessfulSync: lastTime,
        processedCount: raw.processedCount || 0,
        totalRecords: raw.totalRecords,
        error: raw.error,
        retryAfterSeconds: raw.retryAfterSeconds,
      };
      return this.checkpoint;
    }

    return null;
  }

  /**
   * Persists checkpoint state to storage.
   * Zero raw PHI stored.
   */
  async saveCheckpoint(): Promise<void> {
    await this.storage.set({
      [BACKFILL_CHECKPOINT_KEY]: { ...this.checkpoint },
    });
  }

  /**
   * Resets checkpoint state to clean initial values.
   */
  async resetCheckpoint(): Promise<void> {
    const nowIso = new Date().toISOString();
    this.checkpoint = {
      entityType: 'patient',
      cursor: 1,
      status: 'IDLE',
      lastSyncTime: nowIso,
      lastSuccessfulSync: nowIso,
      processedCount: 0,
    };
    await this.storage.remove(BACKFILL_CHECKPOINT_KEY);
  }

  /**
   * Pauses active backfill execution.
   */
  async pause(reason?: string): Promise<void> {
    this.isRunning = false;
    this.checkpoint.status = 'PAUSED';
    if (reason) {
      this.checkpoint.error = reason;
    }
    await this.saveCheckpoint();
  }

  /**
   * Executes a single paginated step for the active entityType.
   * Returns true if more records remain to be processed, false if completed.
   */
  async step(): Promise<boolean> {
    // 1. Leader Lease check
    if (!this.leaseCoordinator.hasActiveLease()) {
      await this.pause('Cannot run backfill: no active leader lease');
      throw new LamaniError('No active leader lease held', 'NO_ACTIVE_LEASE');
    }

    const { entityType, cursor } = this.checkpoint;
    let url: string;

    if (entityType === 'patient') {
      url = `${this.targetOrigin}/api/patients?page=${cursor}&limit=${this.pageSize}`;
    } else {
      // Bounded date window for appointments (today - pastDays to today + futureDays)
      const now = Date.now();
      const pastMs = this.appointmentWindowDaysPast * 24 * 60 * 60 * 1000;
      const futureMs = this.appointmentWindowDaysFuture * 24 * 60 * 60 * 1000;
      const startDate = new Date(now - pastMs).toISOString();
      const endDate = new Date(now + futureMs).toISOString();
      url = `${this.targetOrigin}/api/appointments?page=${cursor}&limit=${this.pageSize}&startDate=${encodeURIComponent(
        startDate
      )}&endDate=${encodeURIComponent(endDate)}&fromDate=${encodeURIComponent(
        startDate
      )}&toDate=${encodeURIComponent(endDate)}`;
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
    } catch (netErr) {
      // 500 / Network Error: pause cleanly without losing cursor
      this.checkpoint.status = 'PAUSED';
      this.checkpoint.error = `Network error: ${(netErr as Error).message}`;
      await this.saveCheckpoint();
      return false;
    }

    // 2. Fault Handling: 401 Unauthorized -> REAUTH_REQUIRED
    if (res.status === 401) {
      if (this.fsm.canTransition('REAUTH_REQUIRED')) {
        this.fsm.transition('REAUTH_REQUIRED', {
          reason: 'CMS session expired during backfill (HTTP 401)',
          connectionId: this.connectionId,
          installationId: this.installationId,
          targetOrigin: this.targetOrigin,
        });
      }
      this.checkpoint.status = 'PAUSED';
      this.checkpoint.error = 'UNAUTHORIZED';
      await this.saveCheckpoint();
      return false;
    }

    // 3. Fault Handling: 429 Rate Limited -> Backoff
    if (res.status === 429) {
      const retryHeader = res.headers.get('Retry-After');
      const retrySeconds = retryHeader ? parseInt(retryHeader, 10) : 30;
      this.checkpoint.status = 'PAUSED';
      this.checkpoint.error = 'RATE_LIMITED';
      this.checkpoint.retryAfterSeconds = Number.isNaN(retrySeconds) ? 30 : retrySeconds;
      await this.saveCheckpoint();
      return false;
    }

    // 4. Fault Handling: 500 Server Error -> Pause without advancing cursor
    if (res.status >= 500) {
      this.checkpoint.status = 'PAUSED';
      this.checkpoint.error = `CMS Server Error (HTTP ${res.status})`;
      await this.saveCheckpoint();
      return false;
    }

    if (!res.ok) {
      this.checkpoint.status = 'ERROR';
      this.checkpoint.error = `CMS request failed with HTTP ${res.status}`;
      await this.saveCheckpoint();
      return false;
    }

    // Parse JSON
    const json = (await res.json()) as Record<string, unknown>;
    const rawItems = (json.data ?? json) as unknown;
    const items = Array.isArray(rawItems) ? rawItems : [];

    if (json.total !== undefined && typeof json.total === 'number') {
      this.checkpoint.totalRecords = json.total;
    }

    // 5. Transform and enqueue SyncEvents
    if (items.length > 0) {
      const events = items.map((item) => {
        return entityType === 'patient'
          ? normalizePatientSyncEvent(item)
          : normalizeAppointmentSyncEvent(item);
      });

      await this.batchUploader.enqueue(events);
      // Flush batch to Sync API
      const result = await this.batchUploader.flush();

      // Rule: Advance cursor ONLY on verified server acknowledgment
      if (!result || !result.acknowledged) {
        throw new LamaniError(
          'Batch not acknowledged by Sync API; checkpoint cursor retained',
          'BATCH_NOT_ACKNOWLEDGED'
        );
      }
    }

    // Advance cursor ONLY after verified acknowledgment
    this.checkpoint.processedCount += items.length;
    const nowIso = new Date().toISOString();
    this.checkpoint.lastSyncTime = nowIso;
    this.checkpoint.lastSuccessfulSync = nowIso;

    if (items.length < this.pageSize) {
      // Current entity backfill finished
      if (entityType === 'patient') {
        // Transition to appointment backfill
        this.checkpoint.entityType = 'appointment';
        this.checkpoint.cursor = 1;
        await this.saveCheckpoint();
        return true;
      } else {
        // All backfills completed!
        this.checkpoint.status = 'COMPLETED';
        await this.saveCheckpoint();
        return false;
      }
    } else {
      // More pages remain for current entity
      this.checkpoint.cursor += 1;
      await this.saveCheckpoint();
      return true;
    }
  }

  /**
   * Starts or resumes backfill loop until completion or pause.
   */
  async start(): Promise<BackfillCheckpoint> {
    await this.restoreCheckpoint();

    if (!this.leaseCoordinator.hasActiveLease()) {
      throw new LamaniError('Cannot start backfill: leader lease is not held', 'NO_ACTIVE_LEASE');
    }

    this.isRunning = true;
    this.checkpoint.status = 'IN_PROGRESS';
    this.checkpoint.error = undefined;
    this.checkpoint.retryAfterSeconds = undefined;
    await this.saveCheckpoint();

    while (this.isRunning && this.checkpoint.status === 'IN_PROGRESS') {
      // Check lease before each page
      if (!this.leaseCoordinator.hasActiveLease()) {
        await this.pause('Leader lease lost during backfill execution');
        break;
      }

      const hasMore = await this.step();
      if (!hasMore) {
        break;
      }
    }

    this.isRunning = false;
    return this.checkpoint;
  }
}
