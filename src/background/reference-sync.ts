/**
 * Reference Data Ingestion & Cache (Phase 7)
 * Ingests and caches healthcare providers, clinic services, and locations.
 * Strictly adheres to AGENTS.md:
 * Rule 4: Zero passwords or session secrets transmitted.
 * Rule 6: No raw PHI stored in chrome.storage.local (reference data contains only public clinic catalog).
 * Rule 7: State survives service worker restart by restoring from local storage.
 */

import { executeRecipe } from '../adapters/interpreter.js';
import { type AdapterManifest } from '../adapters/schema.js';

export const REFERENCE_STORAGE_KEY = 'lamanisync_reference_data';

export interface Provider {
  id: string;
  fullName: string;
  specialty?: string;
  active?: boolean;
}

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  defaultPrice?: number;
}

export interface Location {
  id: string;
  name: string;
  roomType?: string;
}

export interface ReferenceSnapshot {
  providers: Provider[];
  services: Service[];
  locations: Location[];
  syncedAt: string;
}

export interface StorageAdapter {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ReferenceSyncOptions {
  manifest?: AdapterManifest;
  targetOrigin: string;
  storage?: StorageAdapter;
  fetchFn?: typeof fetch;
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

export class ReferenceSyncManager {
  private targetOrigin: string;
  private manifest?: AdapterManifest;
  private storage: StorageAdapter;
  private fetchFn: typeof fetch;

  private providers = new Map<string, Provider>();
  private services = new Map<string, Service>();
  private locations = new Map<string, Location>();
  private lastSyncedAt: string | null = null;

  constructor(options: ReferenceSyncOptions) {
    this.targetOrigin = options.targetOrigin.replace(/\/$/, '');
    this.manifest = options.manifest;
    this.storage = resolveStorage(options.storage);
    this.fetchFn = options.fetchFn || ((...args) => globalThis.fetch(...args));
  }

  setManifest(manifest: AdapterManifest): void {
    this.manifest = manifest;
  }

  setTargetOrigin(origin: string): void {
    this.targetOrigin = origin.replace(/\/$/, '');
  }

  /**
   * Fetches data either through declarative recipe if manifest is present,
   * or direct HTTP GET against known endpoint path.
   */
  private async fetchSection<T>(recipeId: string, directPath: string): Promise<T[]> {
    if (this.manifest && this.manifest.recipes?.[recipeId]) {
      const result = await executeRecipe({
        manifest: this.manifest,
        recipeId,
        baseOrigin: this.targetOrigin,
        fetchFn: this.fetchFn,
      });

      if (result.status === 'SUCCESS' && Array.isArray(result.data)) {
        return result.data as T[];
      }
    }

    // Direct fallback
    const url = `${this.targetOrigin}${directPath}`;
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch ${directPath}: HTTP ${res.status}`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    const items = (json.data ?? json) as unknown;
    return Array.isArray(items) ? (items as T[]) : [];
  }

  /**
   * Performs full reference data ingestion.
   */
  async sync(): Promise<ReferenceSnapshot> {
    const rawProviders = await this.fetchSection<Provider>(
      'reference_providers',
      '/api/reference/providers'
    );
    const rawServices = await this.fetchSection<Service>(
      'reference_services',
      '/api/reference/services'
    );
    const rawLocations = await this.fetchSection<Location>(
      'reference_locations',
      '/api/reference/locations'
    );

    this.providers.clear();
    for (const p of rawProviders) {
      if (p.id) {
        this.providers.set(p.id, {
          id: String(p.id).trim(),
          fullName: String(p.fullName || '').trim(),
          specialty: p.specialty ? String(p.specialty).trim() : undefined,
          active: p.active !== false,
        });
      }
    }

    this.services.clear();
    for (const s of rawServices) {
      if (s.id) {
        this.services.set(s.id, {
          id: String(s.id).trim(),
          name: String(s.name || '').trim(),
          durationMinutes: Number(s.durationMinutes) || 15,
          defaultPrice: s.defaultPrice !== undefined ? Number(s.defaultPrice) : undefined,
        });
      }
    }

    this.locations.clear();
    for (const l of rawLocations) {
      if (l.id) {
        this.locations.set(l.id, {
          id: String(l.id).trim(),
          name: String(l.name || '').trim(),
          roomType: l.roomType ? String(l.roomType).trim() : undefined,
        });
      }
    }

    this.lastSyncedAt = new Date().toISOString();

    const snapshot: ReferenceSnapshot = {
      providers: Array.from(this.providers.values()),
      services: Array.from(this.services.values()),
      locations: Array.from(this.locations.values()),
      syncedAt: this.lastSyncedAt,
    };

    // Persist catalog snapshot to storage (Zero PHI)
    await this.storage.set({ [REFERENCE_STORAGE_KEY]: snapshot });

    return snapshot;
  }

  /**
   * Restores reference cache from local storage across worker restarts.
   */
  async restore(): Promise<ReferenceSnapshot | null> {
    const data = await this.storage.get(REFERENCE_STORAGE_KEY);
    const raw = data[REFERENCE_STORAGE_KEY] as ReferenceSnapshot | undefined;

    if (!raw || !Array.isArray(raw.providers)) {
      return null;
    }

    this.providers.clear();
    for (const p of raw.providers) this.providers.set(p.id, p);

    this.services.clear();
    for (const s of raw.services) this.services.set(s.id, s);

    this.locations.clear();
    for (const l of raw.locations) this.locations.set(l.id, l);

    this.lastSyncedAt = raw.syncedAt || null;

    return raw;
  }

  getProvider(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  getService(id: string): Service | undefined {
    return this.services.get(id);
  }

  getLocation(id: string): Location | undefined {
    return this.locations.get(id);
  }

  getSnapshot(): ReferenceSnapshot | null {
    if (this.providers.size === 0 && this.services.size === 0 && this.locations.size === 0) {
      return null;
    }
    return {
      providers: Array.from(this.providers.values()),
      services: Array.from(this.services.values()),
      locations: Array.from(this.locations.values()),
      syncedAt: this.lastSyncedAt || new Date().toISOString(),
    };
  }
}
