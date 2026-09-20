/**
 * Manifest Lifecycle Manager (Phase 6)
 * Handles manifest download, Ed25519 verification, schema validation,
 * CMS probing, LKG (Last-Known-Good) persistence, and automatic rollback.
 * Strictly adheres to AGENTS.md:
 * Rule 1: Build Manifest V3 only.
 * Rule 2: Never use eval, new Function, remote JavaScript, dynamic remote imports, or arbitrary remote expressions.
 * Rule 3: Never request a runtime host permission broader than the exact paired CMS origin.
 * Rule 9: Validate every message and remote manifest at runtime.
 */

import {
  type AdapterManifest,
  validateAdapterManifest,
  MAX_MANIFEST_SIZE_BYTES,
} from './schema.js';
import { verifyManifestSignature, DEFAULT_PINNED_PUBLIC_KEY } from './verifier.js';
import { LamaniError } from '../core/errors.js';

export const LKG_STORAGE_PREFIX = 'lamanisync_lkg_manifest_';
export const ACTIVE_STORAGE_PREFIX = 'lamanisync_active_manifest_';

export interface StorageAdapter {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class InMemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, unknown>();

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const result: Record<string, unknown> = {};
    for (const k of keyList) {
      if (this.store.has(k)) {
        result[k] = this.store.get(k);
      }
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.store.set(k, v);
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) {
      this.store.delete(k);
    }
  }

  clear(): void {
    this.store.clear();
  }
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
  return new InMemoryStorageAdapter();
}

export interface StoredManifestRecord {
  manifest: AdapterManifest;
  installedAt: string;
  verifiedAt: string;
  status: 'ACTIVE' | 'LKG' | 'ROLLED_BACK';
}

export interface CandidateDownloadOptions {
  syncApiUrl?: string;
  variant?: string;
  targetOrigin?: string;
  fetchFn?: typeof fetch;
}

export interface CandidateVerificationOptions {
  grantedOrigin: string;
  pinnedPublicKey?: string;
  probeEndpoint?: string | false;
  fetchFn?: typeof fetch;
  rawByteLength?: number;
}

export interface ManifestLifecycleOptions {
  storage?: StorageAdapter;
  fetchFn?: typeof fetch;
  pinnedPublicKey?: string;
}

/**
 * Downloads a candidate adapter manifest from the Sync API.
 */
export async function downloadCandidateManifest(
  connectionId: string,
  options: CandidateDownloadOptions = {}
): Promise<unknown> {
  const syncApiUrl = (options.syncApiUrl || 'http://localhost:4002').replace(/\/$/, '');
  const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : undefined);

  if (!fetchFn) {
    throw new LamaniError('fetch is not available in execution context', 'FETCH_UNAVAILABLE');
  }

  const urlObj = new URL(`${syncApiUrl}/v1/sync/connections/${encodeURIComponent(connectionId)}/adapter`);
  if (options.variant) {
    urlObj.searchParams.set('variant', options.variant);
  }
  if (options.targetOrigin) {
    urlObj.searchParams.set('targetOrigin', options.targetOrigin);
  }
  const url = urlObj.toString();

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new LamaniError(
      `Failed to download adapter manifest: ${(err as Error).message}`,
      'TRANSIENT_NETWORK_ERROR'
    );
  }

  if (!res.ok) {
    throw new LamaniError(
      `Sync API returned HTTP ${res.status} when downloading adapter manifest`,
      'DOWNLOAD_FAILED',
      { statusCode: res.status }
    );
  }

  const rawText = await res.text();
  if (rawText.length > MAX_MANIFEST_SIZE_BYTES) {
    throw new LamaniError(
      `Manifest size (${rawText.length} bytes) exceeds limit of ${MAX_MANIFEST_SIZE_BYTES} bytes`,
      'COMPLEXITY_LIMIT_EXCEEDED'
    );
  }

  try {
    return JSON.parse(rawText);
  } catch {
    throw new LamaniError('Downloaded adapter manifest is not valid JSON', 'INVALID_JSON_PAYLOAD');
  }
}

/**
 * Verifies and stages a downloaded candidate manifest:
 * 1. Cryptographic Ed25519 signature check
 * 2. Zod schema validation & complexity limits
 * 3. Origin check against granted host (AGENTS.md Rule 3)
 * 4. Probe test against CMS
 */
export async function verifyAndStageCandidate(
  candidate: unknown,
  options: CandidateVerificationOptions
): Promise<AdapterManifest> {
  const { grantedOrigin, pinnedPublicKey = DEFAULT_PINNED_PUBLIC_KEY, probeEndpoint, fetchFn } = options;

  // 1. Cryptographic Signature Verification
  const sigResult = await verifyManifestSignature(candidate, pinnedPublicKey);
  if (!sigResult.valid) {
    const isUnsigned = sigResult.error === 'MANIFEST_UNSIGNED';
    throw new LamaniError(
      `Candidate manifest cryptographic verification failed: ${sigResult.error}`,
      isUnsigned ? 'MANIFEST_UNSIGNED' : 'MANIFEST_SIGNATURE_INVALID',
      { isRetryable: false, details: { error: sigResult.error } }
    );
  }

  // 2. Zod Schema Validation & Complexity Limits
  let manifest: AdapterManifest;
  try {
    manifest = validateAdapterManifest(candidate, options.rawByteLength);
  } catch (err) {
    throw new LamaniError(
      `Candidate manifest failed schema validation: ${(err as Error).message}`,
      'MANIFEST_SCHEMA_INVALID',
      { cause: err, isRetryable: false }
    );
  }

  // 3. Verify Origin matches granted host (AGENTS.md Rule 3)
  let normalizedGranted: string;
  try {
    const url = new URL(grantedOrigin);
    normalizedGranted = `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    normalizedGranted = grantedOrigin.replace(/\/$/, '').toLowerCase();
  }
  const normalizedTarget = manifest.targetOrigin.replace(/\/$/, '').toLowerCase();

  if (normalizedTarget !== normalizedGranted) {
    throw new LamaniError(
      `Candidate manifest specifies targetOrigin '${manifest.targetOrigin}' outside granted host '${grantedOrigin}'`,
      'UNAUTHORIZED_ORIGIN',
      { isRetryable: false, details: { targetOrigin: manifest.targetOrigin, grantedOrigin } }
    );
  }

  // 4. Run Probe Test against CMS
  if (probeEndpoint !== false && fetchFn) {
    const probePath = probeEndpoint || '/api/reference/providers';
    const probeUrl = `${normalizedTarget}${probePath.startsWith('/') ? probePath : `/${probePath}`}`;

    try {
      const probeRes = await fetchFn(probeUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });

      if (!probeRes.ok) {
        throw new LamaniError(
          `CMS probe test to '${probeUrl}' failed with HTTP ${probeRes.status}`,
          'CMS_PROBE_FAILED',
          { statusCode: probeRes.status }
        );
      }
    } catch (err) {
      if (err instanceof LamaniError) throw err;
      throw new LamaniError(
        `CMS probe test network error: ${(err as Error).message}`,
        'CMS_PROBE_FAILED'
      );
    }
  }

  return manifest;
}

/**
 * Persists an active manifest and saves it as Last-Known-Good (LKG) in storage.
 */
export async function promoteToActive(
  manifest: AdapterManifest,
  options: ManifestLifecycleOptions = {}
): Promise<void> {
  const storage = resolveStorage(options.storage);
  const now = new Date().toISOString();

  const record: StoredManifestRecord = {
    manifest,
    installedAt: now,
    verifiedAt: now,
    status: 'ACTIVE',
  };

  const activeKey = `${ACTIVE_STORAGE_PREFIX}${manifest.adapterId}`;
  const lkgKey = `${LKG_STORAGE_PREFIX}${manifest.adapterId}`;

  await storage.set({
    [activeKey]: record,
    [lkgKey]: { ...record, status: 'LKG' },
  });
}

/**
 * Rolls back to the Last-Known-Good (LKG) manifest stored in local storage.
 */
export async function rollbackToLkg(
  adapterId: string,
  options: ManifestLifecycleOptions = {}
): Promise<AdapterManifest | null> {
  const storage = resolveStorage(options.storage);
  const lkgKey = `${LKG_STORAGE_PREFIX}${adapterId}`;
  const activeKey = `${ACTIVE_STORAGE_PREFIX}${adapterId}`;

  const res = await storage.get(lkgKey);
  const storedRecord = res[lkgKey] as StoredManifestRecord | undefined;

  if (!storedRecord || !storedRecord.manifest) {
    return null;
  }

  // Re-verify LKG signature before promoting
  const pinnedKey = options.pinnedPublicKey || DEFAULT_PINNED_PUBLIC_KEY;
  const sigResult = await verifyManifestSignature(storedRecord.manifest, pinnedKey);
  if (!sigResult.valid) {
    throw new LamaniError(
      `LKG manifest signature is corrupted or invalid: ${sigResult.error}`,
      'CORRUPTED_LKG_MANIFEST'
    );
  }

  const rolledBackRecord: StoredManifestRecord = {
    ...storedRecord,
    verifiedAt: new Date().toISOString(),
    status: 'ROLLED_BACK',
  };

  await storage.set({
    [activeKey]: rolledBackRecord,
  });

  return storedRecord.manifest;
}

/**
 * Gets the active manifest for an adapter ID.
 */
export async function getActiveManifest(
  adapterId: string,
  options: ManifestLifecycleOptions = {}
): Promise<AdapterManifest | null> {
  const storage = resolveStorage(options.storage);
  const activeKey = `${ACTIVE_STORAGE_PREFIX}${adapterId}`;
  const res = await storage.get(activeKey);
  const record = res[activeKey] as StoredManifestRecord | undefined;
  return record?.manifest || null;
}

/**
 * Full lifecycle workflow:
 * 1. Downloads candidate
 * 2. Verifies signature, schema, origin, and runs probe
 * 3. On success: promotes to active and saves LKG
 * 4. On failure: attempts graceful fallback to LKG
 */
export async function syncAndActivateAdapter(
  connectionId: string,
  grantedOrigin: string,
  options: ManifestLifecycleOptions & CandidateDownloadOptions & { probeEndpoint?: string | false; adapterId?: string } = {}
): Promise<{ manifest: AdapterManifest; isRollback: boolean }> {
  const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : undefined);
  const pinnedKey = options.pinnedPublicKey || DEFAULT_PINNED_PUBLIC_KEY;
  const targetAdapterId = options.adapterId || 'acme-cloud-v1';

  let candidate: unknown;
  try {
    candidate = await downloadCandidateManifest(connectionId, {
      syncApiUrl: options.syncApiUrl,
      variant: options.variant,
      targetOrigin: options.targetOrigin || grantedOrigin,
      fetchFn,
    });
  } catch (err) {
    // Download failed, attempt fallback to LKG
    const fallback = await rollbackToLkg(targetAdapterId, options);
    if (fallback) {
      return { manifest: fallback, isRollback: true };
    }
    throw err;
  }

  try {
    const verified = await verifyAndStageCandidate(candidate, {
      grantedOrigin,
      pinnedPublicKey: pinnedKey,
      probeEndpoint: options.probeEndpoint,
      fetchFn,
    });

    await promoteToActive(verified, options);
    return { manifest: verified, isRollback: false };
  } catch (err) {
    // Stage or probe failed, attempt fallback to LKG
    const adapterId = (candidate as Record<string, unknown>)?.adapterId as string || targetAdapterId;
    const fallback = await rollbackToLkg(adapterId, options);
    if (fallback) {
      return { manifest: fallback, isRollback: true };
    }
    throw err;
  }
}
