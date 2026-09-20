/**
 * Deduplication Cache (Phase 7)
 * In-memory bounded LRU cache of (entityType, entityId, revision) and content fingerprints.
 * Strictly adheres to AGENTS.md:
 * Rule 6: Zero raw PHI stored in cache. Only entity IDs, revisions, and cryptographic/deterministic hashes.
 */

export interface DedupeRecord {
  revision: number;
  fingerprint: string;
  seenAt: number;
}

export interface DedupeCacheOptions {
  maxSize?: number;
}

/**
 * Deterministic JSON stringifier that recursively sorts object keys.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }

  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((key) => {
    const val = (obj as Record<string, unknown>)[key];
    return `${JSON.stringify(key)}:${canonicalJsonStringify(val)}`;
  });

  return `{${pairs.join(',')}}`;
}

/**
 * Computes a fast, deterministic 64-bit FNV-1a content fingerprint hash.
 */
export function computeContentFingerprint(payload: unknown): string {
  const jsonStr = canonicalJsonStringify(payload);
  // FNV-1a 64-bit hash
  let h1 = 0x811c9dc5;
  let h2 = 0x84222325;
  for (let i = 0; i < jsonStr.length; i++) {
    const code = jsonStr.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export class DeduplicationCache {
  private readonly maxSize: number;
  private readonly store = new Map<string, DedupeRecord>();

  constructor(options: DedupeCacheOptions = {}) {
    this.maxSize = options.maxSize || 10000;
  }

  private makeKey(entityType: string, entityId: string): string {
    return `${entityType}:${entityId}`;
  }

  /**
   * Checks whether the given entity revision or payload is already known/duplicate.
   * Returns true if duplicate (should be skipped).
   */
  isDuplicate(
    entityType: string,
    entityId: string,
    revision: number,
    payload?: unknown
  ): boolean {
    const key = this.makeKey(entityType, entityId);
    const existing = this.store.get(key);

    if (!existing) {
      return false;
    }

    // Refresh LRU order on access
    this.store.delete(key);
    this.store.set(key, existing);

    // 1. (entityId, revision) deduplication:
    // If existing revision is greater than or equal to incoming revision, it is already processed/stale
    if (existing.revision >= revision) {
      return true;
    }

    // 2. Content fingerprint deduplication:
    // If revision is higher but payload is identical, it is a duplicate
    if (payload !== undefined && existing.fingerprint) {
      const incomingFingerprint = computeContentFingerprint(payload);
      if (existing.fingerprint === incomingFingerprint) {
        return true;
      }
    }

    return false;
  }

  /**
   * Records an entity revision and payload fingerprint in the cache.
   */
  record(
    entityType: string,
    entityId: string,
    revision: number,
    payload?: unknown
  ): void {
    const key = this.makeKey(entityType, entityId);
    const fingerprint = payload !== undefined ? computeContentFingerprint(payload) : '';

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      // Evict oldest (first inserted in Map)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) {
        this.store.delete(oldestKey);
      }
    }

    this.store.set(key, {
      revision,
      fingerprint,
      seenAt: Date.now(),
    });
  }

  /**
   * Explicitly evicts an entity from the cache (e.g. during reconciliation repair).
   */
  evict(entityType: string, entityId: string): void {
    const key = this.makeKey(entityType, entityId);
    this.store.delete(key);
  }

  /**
   * Clears the cache.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns current count of cached entities.
   */
  size(): number {
    return this.store.size;
  }
}
