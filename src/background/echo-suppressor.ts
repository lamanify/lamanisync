/**
 * Echo Suppression Registry (Phase 8)
 * Suppresses inbound observation loopback for outbound mutations executed by the extension.
 * Conforms to AGENTS.md:
 * Rule 6: Do not store raw PHI in chrome.storage.local.
 * Rule 7: Ephemeral SW safe; cache state persists across suspension.
 */

export interface StorageAdapter {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export const ECHO_SUPPRESSOR_STORAGE_KEY = 'lamanisync_echo_fingerprints';

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

export interface EchoSuppressorOptions {
  storage?: StorageAdapter;
  defaultTtlMs?: number;
}

export interface OutboundWriteDetails {
  entityType: 'appointment' | 'patient' | string;
  entityId: string;
  revision?: number;
  providerId?: string;
  startTime?: string;
}

export class EchoSuppressor {
  private cache = new Map<string, number>(); // fingerprint -> expiresAtMs
  private storage: StorageAdapter;
  private defaultTtlMs: number;

  constructor(options: EchoSuppressorOptions = {}) {
    this.storage = resolveStorage(options.storage);
    this.defaultTtlMs = options.defaultTtlMs || 60_000; // 60 seconds
  }

  createFingerprint(entityType: string, entityId: string, revision?: number): string {
    return revision !== undefined ? `${entityType}:${entityId}:${revision}` : `${entityType}:${entityId}`;
  }

  createSlotFingerprint(providerId: string, startTime: string): string {
    const normTime = new Date(startTime).toISOString();
    return `appointment:slot:${providerId}:${normTime}`;
  }

  /**
   * Directly register a fingerprint into the suppression cache.
   */
  suppress(fingerprint: string, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = Date.now() + ttl;
    this.cache.set(fingerprint, expiresAt);
    void this.saveToStorage();
  }

  /**
   * Records an outbound write so subsequent inbound observations are ignored.
   */
  recordOutboundWrite(details: OutboundWriteDetails, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;

    // Entity fingerprint with revision
    if (details.revision !== undefined) {
      this.suppress(this.createFingerprint(details.entityType, details.entityId, details.revision), ttl);
    }
    // Entity fingerprint without revision
    this.suppress(this.createFingerprint(details.entityType, details.entityId), ttl);

    // Slot fingerprint for appointments
    if (details.entityType === 'appointment' && details.providerId && details.startTime) {
      try {
        this.suppress(this.createSlotFingerprint(details.providerId, details.startTime), ttl);
      } catch {
        // invalid date, fallback to literal
        this.suppress(`appointment:slot:${details.providerId}:${details.startTime}`, ttl);
      }
    }
  }

  /**
   * Checks whether a fingerprint is currently suppressed.
   */
  isSuppressed(fingerprint: string): boolean {
    this.cleanupExpired();
    return this.cache.has(fingerprint);
  }

  /**
   * Checks whether an observed entity/event matches any suppressed fingerprints.
   */
  shouldSuppressObservation(obs: {
    entityType?: string;
    entityId?: string;
    revision?: number;
    providerId?: string;
    startTime?: string;
    data?: Record<string, unknown>;
  }): boolean {
    this.cleanupExpired();

    const entityType = obs.entityType || (obs.data?.patientId ? 'appointment' : undefined);
    const entityId = obs.entityId || (obs.data?.id as string | undefined);
    const revision = obs.revision ?? (obs.data?.rev as number | undefined);
    const providerId = obs.providerId || (obs.data?.providerId as string | undefined);
    const startTime = obs.startTime || (obs.data?.startTime as string | undefined);

    if (entityType && entityId) {
      if (revision !== undefined && this.isSuppressed(this.createFingerprint(entityType, entityId, revision))) {
        return true;
      }
      if (this.isSuppressed(this.createFingerprint(entityType, entityId))) {
        return true;
      }
    }

    if (providerId && startTime) {
      try {
        if (this.isSuppressed(this.createSlotFingerprint(providerId, startTime))) {
          return true;
        }
      } catch {
        if (this.isSuppressed(`appointment:slot:${providerId}:${startTime}`)) {
          return true;
        }
      }
    }

    return false;
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const [fp, expiresAt] of this.cache.entries()) {
      if (now >= expiresAt) {
        this.cache.delete(fp);
      }
    }
  }

  async saveToStorage(): Promise<void> {
    this.cleanupExpired();
    const items: Array<[string, number]> = Array.from(this.cache.entries());
    try {
      await this.storage.set({ [ECHO_SUPPRESSOR_STORAGE_KEY]: items });
    } catch {
      // ignore storage failure in tests/fallback
    }
  }

  async restoreFromStorage(): Promise<void> {
    try {
      const res = await this.storage.get(ECHO_SUPPRESSOR_STORAGE_KEY);
      const items = res[ECHO_SUPPRESSOR_STORAGE_KEY];
      if (Array.isArray(items)) {
        const now = Date.now();
        for (const [fp, exp] of items) {
          if (typeof fp === 'string' && typeof exp === 'number' && exp > now) {
            this.cache.set(fp, exp);
          }
        }
      }
    } catch {
      // ignore restore failure
    }
  }

  size(): number {
    this.cleanupExpired();
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    void this.storage.remove(ECHO_SUPPRESSOR_STORAGE_KEY);
  }
}
