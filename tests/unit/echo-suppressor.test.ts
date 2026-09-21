import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EchoSuppressor, type StorageAdapter } from '../../src/background/echo-suppressor.js';

class MockStorage implements StorageAdapter {
  private mem = new Map<string, unknown>();

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const list = Array.isArray(keys) ? keys : [keys];
    const res: Record<string, unknown> = {};
    for (const k of list) {
      if (this.mem.has(k)) res[k] = this.mem.get(k);
    }
    return res;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.mem.set(k, v);
  }

  async remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.mem.delete(k);
  }

  clear(): void {
    this.mem.clear();
  }
}

describe('Echo Suppression Registry (Phase 8)', () => {
  let storage: MockStorage;
  let suppressor: EchoSuppressor;

  beforeEach(() => {
    storage = new MockStorage();
    suppressor = new EchoSuppressor({ storage, defaultTtlMs: 2000 });
  });

  it('records outbound mutation and correctly flags observation for suppression', () => {
    suppressor.recordOutboundWrite({
      entityType: 'appointment',
      entityId: 'APT-001',
      revision: 2,
      providerId: 'DOC-01',
      startTime: '2026-10-01T10:00:00+08:00',
    });

    // 1. Should suppress by entityId + rev
    expect(
      suppressor.shouldSuppressObservation({
        entityType: 'appointment',
        entityId: 'APT-001',
        revision: 2,
      })
    ).toBe(true);

    // 2. Should suppress by entityId alone
    expect(
      suppressor.shouldSuppressObservation({
        entityType: 'appointment',
        entityId: 'APT-001',
        revision: 3,
      })
    ).toBe(true);

    // 3. Should suppress by providerId and startTime
    expect(
      suppressor.shouldSuppressObservation({
        entityType: 'appointment',
        providerId: 'DOC-01',
        startTime: '2026-10-01T10:00:00+08:00',
      })
    ).toBe(true);

    // 4. Unrelated appointment is NOT suppressed
    expect(
      suppressor.shouldSuppressObservation({
        entityType: 'appointment',
        entityId: 'APT-999',
        providerId: 'DOC-02',
        startTime: '2026-10-01T11:00:00+08:00',
      })
    ).toBe(false);
  });

  it('expires suppressed fingerprints after TTL', async () => {
    vi.useFakeTimers();

    suppressor.suppress('test:fingerprint:001', 500);
    expect(suppressor.isSuppressed('test:fingerprint:001')).toBe(true);

    // Advance past TTL
    vi.advanceTimersByTime(600);

    expect(suppressor.isSuppressed('test:fingerprint:001')).toBe(false);

    vi.useRealTimers();
  });

  it('saves and restores fingerprints from storage across ephemeral service worker restart', async () => {
    suppressor.suppress('appointment:APT-555:1', 10000);
    await suppressor.saveToStorage();

    // Create new instance simulating service worker restart
    const restored = new EchoSuppressor({ storage });
    await restored.restoreFromStorage();

    expect(restored.isSuppressed('appointment:APT-555:1')).toBe(true);
    expect(restored.isSuppressed('appointment:APT-NONEXISTENT')).toBe(false);
  });

  it('clears all suppressed fingerprints on demand', () => {
    suppressor.suppress('fp-1');
    suppressor.suppress('fp-2');
    expect(suppressor.size()).toBe(2);

    suppressor.clear();
    expect(suppressor.size()).toBe(0);
    expect(suppressor.isSuppressed('fp-1')).toBe(false);
  });
});
