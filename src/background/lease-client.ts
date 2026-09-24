/**
 * Leader Lease Coordinator (Phase 7)
 * Enforces single-leader execution per connection across extension tabs/workers
 * using fenced leader leases against LamaniHub Sync API.
 * Strictly adheres to AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, or secrets.
 * Rule 7: Ephemeral SW safe; immediately halts polling/backfill if lease is lost or expired.
 */

import { SyncApiClient } from './api-client.js';
import { LamaniError } from '../core/errors.js';

export interface ActiveLease {
  connectionId: string;
  installationId: string;
  leaseId: string;
  fencingToken: number;
  expiresAt: string;
  expiresAtMs: number;
  acquiredAt: number;
}

export const LEASE_STORAGE_KEY = 'lamanisync_active_lease';
export const LEASE_ALARM_NAME = 'lease_renewal';

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

export interface LeaseCoordinatorOptions {
  apiClient: SyncApiClient;
  defaultDurationSeconds?: number;
  storage?: StorageAdapter;
}

export type LeaseLostListener = (reason: string) => void;
export type LeaseAcquiredListener = (lease: ActiveLease) => void;

export class LeaseCoordinator {
  private apiClient: SyncApiClient;
  private defaultDurationSeconds: number;
  private storage: StorageAdapter;
  private currentLease: ActiveLease | null = null;
  private highestFencingToken: number = 0;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  private onLostListeners = new Set<LeaseLostListener>();
  private onAcquiredListeners = new Set<LeaseAcquiredListener>();

  constructor(options: LeaseCoordinatorOptions) {
    this.apiClient = options.apiClient;
    this.defaultDurationSeconds = options.defaultDurationSeconds || 120;
    this.storage = resolveStorage(options.storage);
  }

  /**
   * Returns current active lease or null if not held or expired.
   */
  getActiveLease(): Readonly<ActiveLease> | null {
    if (!this.currentLease) return null;
    if (Date.now() >= this.currentLease.expiresAtMs) {
      this.handleLeaseLost('Lease expired based on local wall clock');
      return null;
    }
    return Object.freeze({ ...this.currentLease });
  }

  /**
   * Checks whether the client currently holds a valid, unexpired leader lease.
   */
  hasActiveLease(): boolean {
    return this.getActiveLease() !== null;
  }

  /**
   * Returns the active monotonic fencing token or null.
   */
  getFencingToken(): number | null {
    const lease = this.getActiveLease();
    return lease ? lease.fencingToken : null;
  }

  /**
   * Attempts to acquire leader lease from Sync API.
   * Enforces strict monotonic fencing token check.
   */
  async acquire(
    connectionId: string,
    installationId: string,
    durationSeconds: number = this.defaultDurationSeconds
  ): Promise<boolean> {
    try {
      const res = await this.apiClient.acquireLease(
        connectionId,
        installationId,
        durationSeconds
      );

      if (res && res.status === 'GRANTED' && res.leaseId && res.fencingToken) {
        // Enforce strict monotonic fencing token
        if (res.fencingToken <= this.highestFencingToken) {
          throw new LamaniError(
            `Stale or non-monotonic fencing token received: ${res.fencingToken} <= ${this.highestFencingToken}`,
            'STALE_FENCING_TOKEN'
          );
        }

        this.highestFencingToken = res.fencingToken;
        const expiresAtMs = new Date(res.expiresAt).getTime();

        this.currentLease = {
          connectionId,
          installationId,
          leaseId: res.leaseId,
          fencingToken: res.fencingToken,
          expiresAt: res.expiresAt,
          expiresAtMs: Number.isNaN(expiresAtMs) ? Date.now() + durationSeconds * 1000 : expiresAtMs,
          acquiredAt: Date.now(),
        };

        await this.saveLeaseToStorage();
        this.scheduleAutoRenewal(durationSeconds);

        // Notify acquired listeners
        for (const listener of this.onAcquiredListeners) {
          try {
            listener(this.currentLease);
          } catch (err) {
            console.error('[LeaseCoordinator] Error in onAcquired listener:', err);
          }
        }

        return true;
      }

      return false;
    } catch (err) {
      this.handleLeaseLost(`Failed to acquire lease: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Renews the active leader lease.
   * If renewal fails, expires, or returns conflict, immediately halts active work.
   */
  async renew(durationSeconds: number = this.defaultDurationSeconds): Promise<boolean> {
    if (!this.currentLease) {
      // Attempt to restore active lease from persistent storage if service worker restarted
      await this.restore();
      if (!this.currentLease) {
        return false;
      }
    }

    const { connectionId, leaseId, fencingToken, installationId } = this.currentLease;

    try {
      const res = await this.apiClient.renewLease(
        connectionId,
        leaseId,
        fencingToken,
        installationId,
        durationSeconds
      );

      if (res && res.status === 'RENEWED' && res.expiresAt) {
        const expiresAtMs = new Date(res.expiresAt).getTime();
        this.currentLease.expiresAt = res.expiresAt;
        this.currentLease.expiresAtMs = Number.isNaN(expiresAtMs)
          ? Date.now() + durationSeconds * 1000
          : expiresAtMs;

        await this.saveLeaseToStorage();
        this.scheduleAutoRenewal(durationSeconds);
        return true;
      }

      this.handleLeaseLost('Server rejected renewal: lease was revoked or expired');
      return false;
    } catch (err) {
      // If error is 409 or network drop causing expiration
      if (Date.now() >= this.currentLease.expiresAtMs) {
        this.handleLeaseLost(`Renewal failed and lease expired: ${(err as Error).message}`);
      }
      return false;
    }
  }

  /**
   * Restores active lease and highest fencing token across service worker suspensions/restarts.
   */
  async restore(): Promise<ActiveLease | null> {
    try {
      const data = await this.storage.get(LEASE_STORAGE_KEY);
      const raw = data[LEASE_STORAGE_KEY] as
        | { lease?: ActiveLease; highestFencingToken?: number }
        | undefined;

      if (raw?.highestFencingToken && raw.highestFencingToken > this.highestFencingToken) {
        this.highestFencingToken = raw.highestFencingToken;
      }

      if (raw?.lease) {
        const lease = raw.lease;
        const now = Date.now();
        if (now >= lease.expiresAtMs) {
          // Expired during suspension/restart
          await this.storage.remove(LEASE_STORAGE_KEY);
          this.handleLeaseLost('Lease expired while service worker was suspended', true);
          return null;
        }

        this.currentLease = lease;
        const remainingSeconds = Math.max(1, Math.round((lease.expiresAtMs - now) / 1000));
        this.scheduleAutoRenewal(remainingSeconds);
        return Object.freeze({ ...this.currentLease });
      }
    } catch (err) {
      console.warn('[LeaseCoordinator] Failed to restore lease state:', err);
    }
    return null;
  }

  private async saveLeaseToStorage(): Promise<void> {
    try {
      if (this.currentLease) {
        await this.storage.set({
          [LEASE_STORAGE_KEY]: {
            lease: this.currentLease,
            highestFencingToken: this.highestFencingToken,
          },
        });
      } else {
        await this.storage.remove(LEASE_STORAGE_KEY);
      }
    } catch (err) {
      console.warn('[LeaseCoordinator] Failed to persist lease state:', err);
    }
  }

  /**
   * Explicitly drops the lease on unpair, worker teardown, or manual release.
   */
  async release(): Promise<void> {
    this.stopAutoRenewal();

    if (!this.currentLease) {
      await this.storage.remove(LEASE_STORAGE_KEY);
      return;
    }

    const { connectionId, leaseId } = this.currentLease;
    try {
      await this.apiClient.releaseLease(connectionId, leaseId);
    } catch (err) {
      console.warn('[LeaseCoordinator] Release lease warning:', err);
    } finally {
      this.handleLeaseLost('Lease explicitly released by client');
    }
  }

  /**
   * Immediate halt of tenant-level polling/backfill on lease loss.
   */
  private handleLeaseLost(reason: string, forceNotify: boolean = false): void {
    const wasHeld = Boolean(this.currentLease) || forceNotify;
    this.currentLease = null;
    this.stopAutoRenewal();
    void this.saveLeaseToStorage();

    if (wasHeld) {
      for (const listener of this.onLostListeners) {
        try {
          listener(reason);
        } catch (err) {
          console.error('[LeaseCoordinator] Error in onLost listener:', err);
        }
      }
    }
  }

  private scheduleAutoRenewal(durationSeconds: number): void {
    this.stopAutoRenewal();
    // Renew halfway through the lease period, minimum 2 seconds
    const intervalMs = Math.max(2000, (durationSeconds * 1000) / 2);

    // 1. Chrome MV3 Alarm scheduling for background wakeups
    if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
      try {
        chrome.alarms.create(LEASE_ALARM_NAME, {
          when: Date.now() + intervalMs,
        });
      } catch (err) {
        console.warn('[LeaseCoordinator] Failed to schedule chrome.alarms for lease renewal:', err);
      }
    }

    // 2. In-memory setTimeout fallback for unit tests and immediate runtime execution
    this.renewalTimer = setTimeout(async () => {
      this.renewalTimer = null;
      if (this.currentLease) {
        await this.renew(durationSeconds);
      }
    }, intervalMs);
  }

  private stopAutoRenewal(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
    if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
      try {
        chrome.alarms.clear(LEASE_ALARM_NAME);
      } catch {
        // ignore
      }
    }
  }

  onLeaseLost(listener: LeaseLostListener): () => void {
    this.onLostListeners.add(listener);
    return () => this.onLostListeners.delete(listener);
  }

  onLeaseAcquired(listener: LeaseAcquiredListener): () => void {
    this.onAcquiredListeners.add(listener);
    return () => this.onAcquiredListeners.delete(listener);
  }

  destroy(): void {
    this.stopAutoRenewal();
    this.currentLease = null;
    this.onLostListeners.clear();
    this.onAcquiredListeners.clear();
  }
}
