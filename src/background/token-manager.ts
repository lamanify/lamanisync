/**
 * Session Token Manager (Phase 10)
 * Proactively renews device session tokens prior to expiration.
 * Recovers seamlessly from expired tokens on 401 errors without interrupting sync.
 * Conforms to AGENTS.md Rules 4, 7, 9.
 */

import { SyncApiClient } from './api-client.js';
import { ConnectionFSM } from './connection-fsm.js';
import {
  type StorageAdapter,
  type ConnectionSession,
  SESSION_STORAGE_KEY,
  ConnectionSessionSchema,
} from './pairing.js';
import { LamaniError } from '../core/errors.js';

export const DEFAULT_RENEWAL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes prior to expiry
export const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

export interface TokenManagerOptions {
  apiClient: SyncApiClient;
  storage: StorageAdapter;
  fsm: ConnectionFSM;
  renewalThresholdMs?: number;
  checkIntervalMs?: number;
}

export class TokenManager {
  private apiClient: SyncApiClient;
  private storage: StorageAdapter;
  private fsm: ConnectionFSM;
  private renewalThresholdMs: number;
  private checkIntervalMs: number;

  private renewalPromise: Promise<ConnectionSession> | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;

  constructor(options: TokenManagerOptions) {
    this.apiClient = options.apiClient;
    this.storage = options.storage;
    this.fsm = options.fsm;
    this.renewalThresholdMs = options.renewalThresholdMs ?? DEFAULT_RENEWAL_THRESHOLD_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  }

  isTokenExpired(expiresAt: string, nowMs: number = Date.now()): boolean {
    const exp = new Date(expiresAt).getTime();
    return Number.isNaN(exp) || exp <= nowMs;
  }

  needsRenewal(expiresAt: string, nowMs: number = Date.now()): boolean {
    const exp = new Date(expiresAt).getTime();
    if (Number.isNaN(exp)) return true;
    return exp - nowMs <= this.renewalThresholdMs;
  }

  /**
   * Retrieves active connection session from storage.
   */
  async getStoredSession(): Promise<ConnectionSession | null> {
    const data = await this.storage.get(SESSION_STORAGE_KEY);
    const raw = data[SESSION_STORAGE_KEY];
    if (!raw) return null;

    const parsed = ConnectionSessionSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data;
  }

  /**
   * Renews the active session token using installation identity.
   * Deduplicates concurrent renewal attempts to prevent race conditions.
   */
  async renewToken(): Promise<ConnectionSession> {
    if (this.renewalPromise) {
      return this.renewalPromise;
    }

    this.renewalPromise = (async () => {
      try {
        const session = await this.getStoredSession();
        if (!session) {
          throw new LamaniError('No active connection session available to renew', 'NOT_PAIRED', {
            statusCode: 401,
          });
        }

        // Call Sync API token renewal endpoint
        const renewal = await this.apiClient.renewSessionToken(session.installationId);

        const updatedSession: ConnectionSession = {
          ...session,
          sessionToken: renewal.sessionToken,
          expiresAt: renewal.expiresAt,
        };

        // Persist updated token to storage
        await this.storage.set({ [SESSION_STORAGE_KEY]: updatedSession });

        // Update active API client token
        this.apiClient.setSessionToken(updatedSession.sessionToken);

        return updatedSession;
      } finally {
        this.renewalPromise = null;
      }
    })();

    return this.renewalPromise;
  }

  /**
   * Ensures that the active session token is valid and unexpired.
   * If token is within renewal threshold or expired, renews it immediately.
   */
  async ensureValidToken(nowMs: number = Date.now()): Promise<string> {
    const session = await this.getStoredSession();
    if (!session) {
      throw new LamaniError('Cannot ensure valid token: device is not paired', 'NOT_PAIRED', {
        statusCode: 401,
      });
    }

    if (this.needsRenewal(session.expiresAt, nowMs)) {
      const renewed = await this.renewToken();
      return renewed.sessionToken;
    }

    return session.sessionToken;
  }

  /**
   * Auto-recovery handler invoked when an API request fails with a 401 / expired token error.
   * Automatically attempts token renewal and updates client credentials.
   */
  async handleTokenExpired(): Promise<boolean> {
    try {
      await this.renewToken();
      return true;
    } catch (err) {
      console.warn('[TokenManager] Expired token auto-recovery failed:', err);

      // If renewal fails due to revocation or 401/403, clean up session
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 401 || status === 403) {
        await this.storage.remove(SESSION_STORAGE_KEY);
        this.apiClient.setSessionToken(null);
        if (this.fsm.canTransition('UNPAIRED')) {
          this.fsm.transition('UNPAIRED', {
            reason: `Session token revoked or expired and cannot be renewed: ${(err as Error).message}`,
          });
        }
      }
      return false;
    }
  }

  /**
   * Evaluates active session and renews if within expiration buffer.
   */
  async checkAndRenew(): Promise<boolean> {
    try {
      const session = await this.getStoredSession();
      if (!session) return false;

      if (this.needsRenewal(session.expiresAt)) {
        await this.renewToken();
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[TokenManager] Proactive renewal check failed:', err);
      return false;
    }
  }

  /**
   * Starts periodic proactive token renewal timer.
   */
  startProactiveRenewal(intervalMs?: number): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const interval = intervalMs ?? this.checkIntervalMs;
    this.checkTimer = setInterval(() => {
      this.checkAndRenew().catch(() => {});
    }, interval);
  }

  /**
   * Stops proactive renewal timer.
   */
  stopProactiveRenewal(): void {
    this.isRunning = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  isActive(): boolean {
    return this.isRunning;
  }
}
