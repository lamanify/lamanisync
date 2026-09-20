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

export interface LeaseCoordinatorOptions {
  apiClient: SyncApiClient;
  defaultDurationSeconds?: number;
}

export type LeaseLostListener = (reason: string) => void;
export type LeaseAcquiredListener = (lease: ActiveLease) => void;

export class LeaseCoordinator {
  private apiClient: SyncApiClient;
  private defaultDurationSeconds: number;
  private currentLease: ActiveLease | null = null;
  private highestFencingToken: number = 0;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;

  private onLostListeners = new Set<LeaseLostListener>();
  private onAcquiredListeners = new Set<LeaseAcquiredListener>();

  constructor(options: LeaseCoordinatorOptions) {
    this.apiClient = options.apiClient;
    this.defaultDurationSeconds = options.defaultDurationSeconds || 30;
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
      return false;
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
   * Explicitly drops the lease on unpair, worker teardown, or manual release.
   */
  async release(): Promise<void> {
    this.stopAutoRenewal();

    if (!this.currentLease) {
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
  private handleLeaseLost(reason: string): void {
    const wasHeld = Boolean(this.currentLease);
    this.currentLease = null;
    this.stopAutoRenewal();

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
