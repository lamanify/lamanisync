/**
 * Request Signer & Replay Protection (Phase 10)
 * Computes deterministic canonical strings over (method, path, timestamp, nonce, bodyHash).
 * Signs with non-exportable device key (ECDSA P-256) and verifies payloads against tampering.
 * Enforces server/client-side replay protection: clock drift <= 60s and unique nonce tracking.
 * Conforms to AGENTS.md Rules 2, 4, 7, 9.
 */

import { signPayload, base64ToUint8Array, arrayBufferToBase64 } from '../../storage/device-key.js';
import { LamaniError } from '../errors.js';

export const MAX_CLOCK_DRIFT_MS = 60_000; // 60 seconds tolerance

/**
 * Computes SHA-256 hex digest of payload string or Uint8Array.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digestBuffer = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const hashArray = Array.from(new Uint8Array(digestBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Creates canonical string for request signing:
 * METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
 */
export function createCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export interface SignRequestOptions {
  method: string;
  url: string | URL;
  body?: unknown;
  timestamp?: string;
  nonce?: string;
  correlationId?: string;
  clockSkewMs?: number;
  idbFactory?: IDBFactory;
  privateKey?: CryptoKey;
}

export interface SignedRequestResult {
  headers: Record<string, string>;
  canonicalString: string;
  bodyHash: string;
  signature: string;
  timestamp: string;
  nonce: string;
  correlationId: string;
}

/**
 * Signs an outbound HTTP request using the device private key.
 * Injects X-Device-Timestamp, X-Device-Nonce, X-Correlation-ID, and X-Device-Signature.
 */
export async function signRequest(options: SignRequestOptions): Promise<SignedRequestResult> {
  const method = options.method.toUpperCase();

  // Extract path with query string
  let pathWithQuery: string;
  if (typeof options.url === 'string') {
    try {
      const parsed = options.url.includes('://')
        ? new URL(options.url)
        : new URL(options.url, 'http://localhost');
      pathWithQuery = parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
    } catch {
      pathWithQuery = options.url;
    }
  } else {
    pathWithQuery = options.url.search
      ? `${options.url.pathname}${options.url.search}`
      : options.url.pathname;
  }

  // Compute body hash
  let bodyString = '';
  if (options.body !== undefined && options.body !== null) {
    bodyString = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const bodyHash = await sha256Hex(bodyString);

  // Generate or reuse timestamp and nonce
  const timestamp =
    options.timestamp ||
    new Date(Date.now() + (options.clockSkewMs || 0)).toISOString();
  const nonce = options.nonce || crypto.randomUUID();
  const correlationId = options.correlationId || crypto.randomUUID();

  // Create canonical string
  const canonicalString = createCanonicalString(method, pathWithQuery, timestamp, nonce, bodyHash);

  let signature: string;
  try {
    if (options.privateKey) {
      const dataBytes = new TextEncoder().encode(canonicalString);
      const sigBuf = await crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        options.privateKey,
        dataBytes
      );
      signature = arrayBufferToBase64(sigBuf);
    } else {
      signature = await signPayload(canonicalString, options.idbFactory);
    }
  } catch (err) {
    throw new LamaniError('Failed to sign request with device identity key', 'SIGNING_FAILED', {
      cause: err,
    });
  }

  const headers: Record<string, string> = {
    'x-correlation-id': correlationId,
    'x-device-timestamp': timestamp,
    'x-device-nonce': nonce,
    'x-device-signature': signature,
  };

  return {
    headers,
    canonicalString,
    bodyHash,
    signature,
    timestamp,
    nonce,
    correlationId,
  };
}

export interface VerifySignatureOptions {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
  signature: string;
  publicKeySpki: string;
}

/**
 * Verifies request signature against client device public key (ECDSA P-256 SPKI).
 * Ensures body tampering or header alteration is detected.
 */
export async function verifyRequestSignature(
  options: VerifySignatureOptions
): Promise<{ valid: boolean; reason?: string }> {
  try {
    let bodyString = '';
    if (options.body !== undefined && options.body !== null) {
      bodyString = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    const bodyHash = await sha256Hex(bodyString);
    const canonicalString = createCanonicalString(
      options.method,
      options.path,
      options.timestamp,
      options.nonce,
      bodyHash
    );

    const keyBytes = base64ToUint8Array(options.publicKeySpki);
    const publicKey = await crypto.subtle.importKey(
      'spki',
      keyBytes as unknown as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    const sigBytes = base64ToUint8Array(options.signature);
    const dataBytes = new TextEncoder().encode(canonicalString);

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      publicKey,
      sigBytes as unknown as BufferSource,
      dataBytes as unknown as BufferSource
    );

    return { valid, reason: valid ? undefined : 'Signature verification failed' };
  } catch (err) {
    return { valid: false, reason: (err as Error).message };
  }
}

export interface ReplayCheckResult {
  valid: boolean;
  code?: 'MISSING_REPLAY_HEADERS' | 'INVALID_TIMESTAMP' | 'CLOCK_DRIFT_EXCEEDED' | 'NONCE_REPLAY_DETECTED';
  message?: string;
}

/**
 * Validates request timestamp and nonce for replay protection.
 * Rejects requests with clock drift > 60s or duplicate nonces.
 */
export class ReplayProtectionManager {
  private seenNonces: Map<string, number> = new Map();
  private maxDriftMs: number;

  constructor(maxDriftMs: number = MAX_CLOCK_DRIFT_MS) {
    this.maxDriftMs = maxDriftMs;
  }

  setMaxDrift(ms: number): void {
    this.maxDriftMs = ms;
  }

  reset(): void {
    this.seenNonces.clear();
  }

  /**
   * Evaluates request timestamp freshness and nonce uniqueness.
   */
  evaluate(
    timestampStr: string | null | undefined,
    nonce: string | null | undefined,
    nowMs: number = Date.now()
  ): ReplayCheckResult {
    if (!timestampStr || !nonce) {
      return {
        valid: false,
        code: 'MISSING_REPLAY_HEADERS',
        message: 'Missing x-device-timestamp or x-device-nonce headers',
      };
    }

    const timestampMs = new Date(timestampStr).getTime();
    if (Number.isNaN(timestampMs)) {
      return {
        valid: false,
        code: 'INVALID_TIMESTAMP',
        message: 'Invalid ISO-8601 timestamp in x-device-timestamp',
      };
    }

    const drift = Math.abs(nowMs - timestampMs);
    if (drift > this.maxDriftMs) {
      return {
        valid: false,
        code: 'CLOCK_DRIFT_EXCEEDED',
        message: `Request timestamp drift (${Math.round(drift / 1000)}s) exceeds ${this.maxDriftMs / 1000}s tolerance`,
      };
    }

    if (this.seenNonces.has(nonce)) {
      return {
        valid: false,
        code: 'NONCE_REPLAY_DETECTED',
        message: `Nonce '${nonce}' has already been processed (replay attack detected)`,
      };
    }

    // Prune expired nonces older than 2 * maxDriftMs
    const cutoff = nowMs - this.maxDriftMs * 2;
    for (const [key, seenAt] of this.seenNonces.entries()) {
      if (seenAt < cutoff) {
        this.seenNonces.delete(key);
      }
    }

    this.seenNonces.set(nonce, nowMs);

    return { valid: true };
  }
}
