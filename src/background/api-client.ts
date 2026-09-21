/**
 * Sync API Client (Phase 4)
 * HTTP transport to LamaniHub Mock Sync API (default: http://localhost:4002).
 * Signs requests using the device non-exportable private key, timestamp, and unique nonce.
 * Enforces strict runtime response validation via Zod schemas.
 * Never transmits CMS passwords, cookies, or secrets (AGENTS.md Rule 4).
 */

import { z } from 'zod';
import { TargetOriginSchema } from '../core/contracts/primitives.js';
import { type SyncEvent, BatchSyncEventsSchema } from '../core/contracts/events.js';
import {
  type SyncCommand,
  SyncCommandSchema,
  type CommandResultStatus,
  type WriteReceipt,
} from '../core/contracts/commands.js';
import { LamaniError, classifyError } from '../core/errors.js';
import { getSyncApiUrl } from '../config/env.js';
import { signRequest } from '../core/crypto/signer.js';

export const PairingResponseSchema = z.object({
  installationId: z.string().min(1, 'installationId is required'),
  connectionId: z.string().min(1, 'connectionId is required'),
  clinicId: z.string().min(1, 'clinicId is required'),
  sessionToken: z.string().min(1, 'sessionToken is required'),
  expiresAt: z.string().min(1, 'expiresAt is required'),
  targetOrigin: TargetOriginSchema,
});

export type PairingResponse = z.infer<typeof PairingResponseSchema>;

export interface ApiClientConfig {
  baseUrl?: string;
  sessionToken?: string | null;
  fetchFn?: typeof fetch;
  idbFactory?: IDBFactory;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  correlationId?: string;
  skipSigning?: boolean;
  skipAuthHeader?: boolean;
}

export class SyncApiClient {
  private baseUrl: string;
  private sessionToken: string | null;
  private fetchFn: typeof fetch;
  private idbFactory?: IDBFactory;
  private clockSkewMs: number = 0;
  private killSwitchHandler?: (payload: unknown) => void;
  private tokenRecoveryHandler?: () => Promise<boolean>;

  constructor(config: ApiClientConfig = {}) {
    this.baseUrl = config.baseUrl || getSyncApiUrl();
    this.sessionToken = config.sessionToken ?? null;
    this.fetchFn = config.fetchFn || ((...args) => globalThis.fetch(...args));
    this.idbFactory = config.idbFactory;
  }

  setFetchFn(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  setIdbFactory(factory?: IDBFactory): void {
    this.idbFactory = factory;
  }

  setSessionToken(token: string | null): void {
    this.sessionToken = token;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setClockSkew(skewMs: number): void {
    this.clockSkewMs = skewMs;
  }

  getClockSkew(): number {
    return this.clockSkewMs;
  }

  updateClockSkew(serverTimeIso: string): void {
    const serverMs = new Date(serverTimeIso).getTime();
    if (!Number.isNaN(serverMs)) {
      this.clockSkewMs = serverMs - Date.now();
    }
  }

  setKillSwitchHandler(handler?: (payload: unknown) => void): void {
    this.killSwitchHandler = handler;
  }

  setTokenRecoveryHandler(handler?: () => Promise<boolean>): void {
    this.tokenRecoveryHandler = handler;
  }

  async request<T>(path: string, options: RequestOptions = {}, isRetry: boolean = false): Promise<T> {
    const method = options.method || 'GET';
    const correlationId = options.correlationId || crypto.randomUUID();
    const url = new URL(path, this.baseUrl);
    const bodyString = options.body !== undefined ? JSON.stringify(options.body) : '';

    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (!options.skipSigning) {
      const signed = await signRequest({
        method,
        url,
        body: options.body,
        correlationId,
        clockSkewMs: this.clockSkewMs,
        idbFactory: this.idbFactory,
      });
      headers = {
        ...headers,
        ...signed.headers,
      };
    } else {
      headers['x-correlation-id'] = correlationId;
      headers['x-device-timestamp'] = new Date(Date.now() + this.clockSkewMs).toISOString();
      headers['x-device-nonce'] = crypto.randomUUID();
    }

    if (this.sessionToken && !options.skipAuthHeader) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
    }

    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method,
        headers,
        body: method !== 'GET' && method !== 'DELETE' ? bodyString : undefined,
      });
    } catch (netErr) {
      throw new LamaniError('Network connection to Sync API failed', 'TRANSIENT_NETWORK_ERROR', {
        statusCode: 503,
        cause: netErr,
      });
    }

    let responseBody: unknown;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        responseBody = await response.json();
      } catch {
        responseBody = null;
      }
    } else {
      responseBody = await response.text();
    }

    if (!response.ok) {
      const errObj = typeof responseBody === 'object' && responseBody !== null
        ? (responseBody as Record<string, unknown>)
        : {};

      // Check remote kill-switch signals (403 or PAUSED)
      if (
        response.status === 403 ||
        errObj.status === 'PAUSED' ||
        errObj.error === 'PAUSED' ||
        errObj.paused === true
      ) {
        this.killSwitchHandler?.(responseBody || { status: 'PAUSED' });
      }

      // Expired token auto-recovery (401 Unauthorized), avoiding recursive renewal loops
      const isRenewalEndpoint = path.includes('/tokens/renew') || path.includes('/session/renew');
      if (response.status === 401 && !isRetry && this.tokenRecoveryHandler && !isRenewalEndpoint) {
        const recovered = await this.tokenRecoveryHandler();
        if (recovered) {
          // Retry original request once with new token
          return this.request<T>(path, options, true);
        }
      }

      if (errObj.error === 'PAIRING_CODE_EXPIRED') {
        throw new LamaniError(
          (errObj.message as string) || 'The pairing code has expired',
          'PAIRING_CODE_EXPIRED',
          { statusCode: 400, details: { error: 'PAIRING_CODE_EXPIRED' } }
        );
      }

      throw classifyError(responseBody, {
        statusCode: response.status,
        endpoint: url.pathname,
        method,
        source: 'sync_api',
      });
    }

    // Also check 200 responses that may carry a PAUSED kill-switch indicator
    if (
      typeof responseBody === 'object' &&
      responseBody !== null &&
      (responseBody as Record<string, unknown>).status === 'PAUSED'
    ) {
      this.killSwitchHandler?.(responseBody);
    }

    return responseBody as T;
  }

  /**
   * Proactively renews device session token via POST /v1/sync/tokens/renew.
   */
  async renewSessionToken(installationId: string): Promise<{ sessionToken: string; expiresAt: string }> {
    const res = await this.request<{ sessionToken: string; expiresAt: string }>('/v1/sync/tokens/renew', {
      method: 'POST',
      body: { installationId },
      skipAuthHeader: true,
    });
    if (res?.sessionToken) {
      this.sessionToken = res.sessionToken;
    }
    return res;
  }

  /**
   * Performs the pairing handshake with POST /v1/sync/installations/pair.
   */
  async pair(
    pairingCode: string,
    clientPublicKey: string,
    deviceName: string = 'Chrome Extension'
  ): Promise<PairingResponse> {
    const data = await this.request<unknown>('/v1/sync/installations/pair', {
      method: 'POST',
      body: {
        pairingCode,
        clientPublicKey,
        deviceName,
      },
    });

    const parsed = PairingResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new LamaniError('Invalid pairing response schema from Sync API', 'CMS_SCHEMA_ERROR', {
        statusCode: 502,
        details: { issues: parsed.error.issues },
      });
    }

    // Set session token in client
    this.sessionToken = parsed.data.sessionToken;

    return parsed.data;
  }

  /**
   * Revokes an installation with POST /v1/sync/installations/revoke.
   */
  async revoke(installationId: string): Promise<{ status: string }> {
    const result = await this.request<{ status: string }>('/v1/sync/installations/revoke', {
      method: 'POST',
      body: { installationId },
    });
    this.sessionToken = null;
    return result;
  }

  /**
   * Sends periodic health ping with POST /v1/sync/installations/heartbeat.
   */
  async heartbeat(
    installationId: string,
    version: string = '0.1.0',
    status: string = 'ACTIVE'
  ): Promise<{ status: string; serverTime: string }> {
    const res = await this.request<{ status: string; serverTime: string }>('/v1/sync/installations/heartbeat', {
      method: 'POST',
      body: {
        installationId,
        version,
        status,
      },
    });
    if (res?.serverTime) {
      this.updateClockSkew(res.serverTime);
    }
    return res;
  }

  /**
   * Acquires a leader lease with POST /v1/sync/leases/acquire.
   */
  async acquireLease(
    connectionId: string,
    installationId: string,
    durationSeconds: number = 30
  ): Promise<{ status: string; leaseId: string; fencingToken: number; expiresAt: string }> {
    return this.request('/v1/sync/leases/acquire', {
      method: 'POST',
      body: { connectionId, installationId, durationSeconds },
    });
  }

  /**
   * Renews an active leader lease with POST /v1/sync/leases/renew.
   */
  async renewLease(
    connectionId: string,
    leaseId: string,
    fencingToken: number,
    installationId: string,
    durationSeconds: number = 30
  ): Promise<{ status: string; leaseId: string; fencingToken: number; expiresAt: string }> {
    return this.request('/v1/sync/leases/renew', {
      method: 'POST',
      body: { connectionId, leaseId, fencingToken, installationId, durationSeconds },
    });
  }

  /**
   * Releases an active leader lease with POST /v1/sync/leases/release.
   */
  async releaseLease(connectionId: string, leaseId: string): Promise<{ status: string }> {
    return this.request('/v1/sync/leases/release', {
      method: 'POST',
      body: { connectionId, leaseId },
    });
  }

  /**
   * Fetches public key from GET /v1/sync/public-key.
   */
  async getPublicKey(): Promise<{ publicKey: string }> {
    return this.request<{ publicKey: string }>('/v1/sync/public-key', {
      method: 'GET',
      skipSigning: true,
    });
  }

  /**
   * Fetches signed adapter manifest for a connection.
   */
  async fetchAdapterManifest(connectionId: string, variant?: string): Promise<unknown> {
    const path = `/v1/sync/connections/${encodeURIComponent(connectionId)}/adapter${
      variant ? `?variant=${encodeURIComponent(variant)}` : ''
    }`;
    return this.request<unknown>(path, { method: 'GET' });
  }

  /**
   * Submits environment & capability probe result to POST /v1/sync/connections/:id/probe-result.
   */
  async reportProbeResult(
    connectionId: string,
    payload: {
      installationId: string;
      capabilities: string[];
      cmsVersion: string;
      passed: boolean;
      details?: Record<string, unknown>;
    }
  ): Promise<{ status: string; connectionId: string; recordedAt: string }> {
    return this.request(`/v1/sync/connections/${encodeURIComponent(connectionId)}/probe-result`, {
      method: 'POST',
      body: payload,
    });
  }

  /**
   * Transmits batch of normalized sync events to POST /v1/sync/events/batch.
   */
  async sendEventBatch(
    installationId: string,
    events: SyncEvent[],
    batchId?: string
  ): Promise<{ acknowledged: boolean; batchId: string; processedCount: number; checkpoint: string }> {
    const finalBatchId = batchId || `batch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const parsed = BatchSyncEventsSchema.safeParse({
      installationId,
      batchId: finalBatchId,
      events,
    });

    if (!parsed.success) {
      throw new LamaniError('Invalid event batch payload schema', 'CMS_SCHEMA_ERROR', {
        statusCode: 400,
        details: { issues: parsed.error.issues },
      });
    }

    return this.request('/v1/sync/events/batch', {
      method: 'POST',
      body: parsed.data,
    });
  }

  /**
   * Fetches reconciliation summary from GET /v1/sync/connections/:id/reconcile-summary.
   */
  async getReconcileSummary(connectionId: string): Promise<{
    connectionId: string;
    totalEvents: number;
    entityCounts: Record<string, number>;
    knownEntityIds: Record<string, string[]>;
    entityRevisions: Record<string, number>;
  }> {
    return this.request(`/v1/sync/connections/${encodeURIComponent(connectionId)}/reconcile-summary`, {
      method: 'GET',
    });
  }

  /**
   * Fetches next pending command from outbox via GET /v1/sync/outbox/next.
   */
  async fetchNextCommand(connectionId: string): Promise<SyncCommand | null> {
    const path = `/v1/sync/outbox/next?connectionId=${encodeURIComponent(connectionId)}`;
    const data = await this.request<{ command: unknown | null }>(path, { method: 'GET' });
    if (!data || !data.command) {
      return null;
    }
    return SyncCommandSchema.parse(data.command);
  }

  /**
   * Reports command execution result via POST /v1/sync/outbox/:commandId/result.
   */
  async reportCommandResult(
    commandId: string,
    result: {
      status: CommandResultStatus;
      writeReceipt?: WriteReceipt;
      error?: unknown;
    }
  ): Promise<{ acknowledged: boolean; commandId: string; status: string }> {
    const path = `/v1/sync/outbox/${encodeURIComponent(commandId)}/result`;
    return this.request(path, {
      method: 'POST',
      body: {
        status: result.status,
        writeReceipt: result.writeReceipt,
        error: result.error,
      },
    });
  }
}
