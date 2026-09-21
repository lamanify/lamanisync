// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sha256Hex,
  createCanonicalString,
  signRequest,
  verifyRequestSignature,
  ReplayProtectionManager,
} from '../../src/core/crypto/signer.js';
import { setIndexedDbFactory, getOrCreateDeviceKey } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';

describe('HTTP Request Signer & Replay Protection (Phase 10)', () => {
  let mockIdb: IDBFactory;

  beforeEach(() => {
    mockIdb = createMockIDBFactory();
    setIndexedDbFactory(mockIdb);
  });

  describe('sha256Hex', () => {
    it('computes known SHA-256 digest for empty string', async () => {
      const hash = await sha256Hex('');
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('computes consistent digest for payload string', async () => {
      const hash1 = await sha256Hex('{"patientId":"P-01"}');
      const hash2 = await sha256Hex('{"patientId":"P-01"}');
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);
    });
  });

  describe('createCanonicalString', () => {
    it('formats canonical string deterministically', () => {
      const canonical = createCanonicalString(
        'POST',
        '/v1/sync/events/batch?foo=bar',
        '2026-09-21T10:00:00.000Z',
        'nonce-123',
        'abcdef123456'
      );
      expect(canonical).toBe(
        'POST\n/v1/sync/events/batch?foo=bar\n2026-09-21T10:00:00.000Z\nnonce-123\nabcdef123456'
      );
    });
  });

  describe('signRequest and verifyRequestSignature', () => {
    it('signs and verifies valid request payload with device key', async () => {
      const { publicKeySpki } = await getOrCreateDeviceKey(mockIdb);

      const signed = await signRequest({
        method: 'POST',
        url: 'http://localhost:4002/v1/sync/events/batch',
        body: { events: [{ id: 'evt-1' }] },
        idbFactory: mockIdb,
      });

      expect(signed.headers['x-device-signature']).toBeTruthy();
      expect(signed.headers['x-device-timestamp']).toBeTruthy();
      expect(signed.headers['x-device-nonce']).toBeTruthy();
      expect(signed.headers['x-correlation-id']).toBeTruthy();

      const verification = await verifyRequestSignature({
        method: 'POST',
        path: '/v1/sync/events/batch',
        timestamp: signed.timestamp,
        nonce: signed.nonce,
        body: { events: [{ id: 'evt-1' }] },
        signature: signed.signature,
        publicKeySpki,
      });

      expect(verification.valid).toBe(true);
    });

    it('detects and rejects body tampering', async () => {
      const { publicKeySpki } = await getOrCreateDeviceKey(mockIdb);

      const signed = await signRequest({
        method: 'POST',
        url: '/v1/sync/events/batch',
        body: { amount: 100 },
        idbFactory: mockIdb,
      });

      // Tampered body
      const verification = await verifyRequestSignature({
        method: 'POST',
        path: '/v1/sync/events/batch',
        timestamp: signed.timestamp,
        nonce: signed.nonce,
        body: { amount: 999999 }, // tampered!
        signature: signed.signature,
        publicKeySpki,
      });

      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('Signature verification failed');
    });

    it('detects and rejects path or query tampering', async () => {
      const { publicKeySpki } = await getOrCreateDeviceKey(mockIdb);

      const signed = await signRequest({
        method: 'GET',
        url: '/v1/sync/outbox/next?connectionId=conn_1',
        idbFactory: mockIdb,
      });

      // Tampered path
      const verification = await verifyRequestSignature({
        method: 'GET',
        path: '/v1/sync/outbox/next?connectionId=conn_tampered',
        timestamp: signed.timestamp,
        nonce: signed.nonce,
        body: '',
        signature: signed.signature,
        publicKeySpki,
      });

      expect(verification.valid).toBe(false);
    });
  });

  describe('ReplayProtectionManager', () => {
    let replayManager: ReplayProtectionManager;

    beforeEach(() => {
      replayManager = new ReplayProtectionManager(60_000); // 60s
    });

    it('accepts fresh requests with unique nonces', () => {
      const now = Date.now();
      const res1 = replayManager.evaluate(new Date(now).toISOString(), 'nonce-1', now);
      expect(res1.valid).toBe(true);

      const res2 = replayManager.evaluate(new Date(now + 1000).toISOString(), 'nonce-2', now);
      expect(res2.valid).toBe(true);
    });

    it('rejects duplicate nonces (replay attack)', () => {
      const now = Date.now();
      const res1 = replayManager.evaluate(new Date(now).toISOString(), 'replayed-nonce', now);
      expect(res1.valid).toBe(true);

      const res2 = replayManager.evaluate(new Date(now + 2000).toISOString(), 'replayed-nonce', now);
      expect(res2.valid).toBe(false);
      expect(res2.code).toBe('NONCE_REPLAY_DETECTED');
    });

    it('rejects timestamp drift exceeding 60 seconds (past or future)', () => {
      const now = Date.now();

      // 61 seconds in past
      const pastRes = replayManager.evaluate(new Date(now - 61_000).toISOString(), 'nonce-past', now);
      expect(pastRes.valid).toBe(false);
      expect(pastRes.code).toBe('CLOCK_DRIFT_EXCEEDED');

      // 61 seconds in future
      const futureRes = replayManager.evaluate(new Date(now + 61_000).toISOString(), 'nonce-future', now);
      expect(futureRes.valid).toBe(false);
      expect(futureRes.code).toBe('CLOCK_DRIFT_EXCEEDED');
    });

    it('rejects missing or malformed timestamp/nonce', () => {
      const now = Date.now();
      expect(replayManager.evaluate(null, 'nonce', now).code).toBe('MISSING_REPLAY_HEADERS');
      expect(replayManager.evaluate(new Date().toISOString(), null, now).code).toBe('MISSING_REPLAY_HEADERS');
      expect(replayManager.evaluate('invalid-date', 'nonce', now).code).toBe('INVALID_TIMESTAMP');
    });
  });
});
