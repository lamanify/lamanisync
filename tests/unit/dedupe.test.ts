// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  DeduplicationCache,
  canonicalJsonStringify,
  computeContentFingerprint,
} from '../../src/background/dedupe.js';

describe('Deduplication Cache & Content Fingerprinting (Phase 7)', () => {
  it('produces identical canonical JSON strings regardless of key ordering', () => {
    const obj1 = { b: 2, a: 1, nested: { y: 'two', x: 'one' } };
    const obj2 = { a: 1, nested: { x: 'one', y: 'two' }, b: 2 };

    expect(canonicalJsonStringify(obj1)).toBe(canonicalJsonStringify(obj2));
    expect(computeContentFingerprint(obj1)).toBe(computeContentFingerprint(obj2));
  });

  it('detects duplicate events with the same revision and identical payload', () => {
    const cache = new DeduplicationCache();
    const payload = { fullName: 'Alice', phone: '+60123456701' };

    expect(cache.isDuplicate('patient', 'P-01', 1, payload)).toBe(false);

    cache.record('patient', 'P-01', 1, payload);

    expect(cache.isDuplicate('patient', 'P-01', 1, payload)).toBe(true);
  });

  it('rejects stale revisions (existing revision > incoming revision)', () => {
    const cache = new DeduplicationCache();
    cache.record('patient', 'P-01', 5);

    // Incoming event has revision 3 (stale delivery)
    expect(cache.isDuplicate('patient', 'P-01', 3)).toBe(true);
    expect(cache.isDuplicate('patient', 'P-01', 4)).toBe(true);
  });

  it('detects duplicate when revision bumps but content fingerprint is identical', () => {
    const cache = new DeduplicationCache();
    const payload = { startTime: '2026-10-01T09:00:00+08:00', status: 'booked' };

    cache.record('appointment', 'APT-01', 1, payload);

    // Same content even though revision bumped
    expect(cache.isDuplicate('appointment', 'APT-01', 2, payload)).toBe(true);
  });

  it('processes incoming event when payload actually changed with new revision', () => {
    const cache = new DeduplicationCache();
    const payload1 = { startTime: '2026-10-01T09:00:00+08:00', status: 'booked' };
    const payload2 = { startTime: '2026-10-01T10:00:00+08:00', status: 'booked' };

    cache.record('appointment', 'APT-01', 1, payload1);

    expect(cache.isDuplicate('appointment', 'APT-01', 2, payload2)).toBe(false);
  });

  it('enforces bounded LRU eviction when exceeding maxSize', () => {
    const cache = new DeduplicationCache({ maxSize: 3 });

    cache.record('patient', 'P-01', 1);
    cache.record('patient', 'P-02', 1);
    cache.record('patient', 'P-03', 1);
    expect(cache.size()).toBe(3);

    // Insert 4th: should evict P-01
    cache.record('patient', 'P-04', 1);
    expect(cache.size()).toBe(3);
    expect(cache.isDuplicate('patient', 'P-01', 1)).toBe(false);
    expect(cache.isDuplicate('patient', 'P-04', 1)).toBe(true);
  });
});
