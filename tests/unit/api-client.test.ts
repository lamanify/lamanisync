// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncApiClient } from '../../src/background/api-client.js';
import { setIndexedDbFactory } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';
import { LamaniError } from '../../src/core/errors.js';

describe('SyncApiClient', () => {
  beforeEach(() => {
    setIndexedDbFactory(createMockIDBFactory());
  });

  it('signs requests with device key, timestamp, and nonce', async () => {
    let capturedHeaders: Headers | undefined;

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedHeaders = new Headers(init.headers);
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await client.request('/test-endpoint', {
      method: 'POST',
      body: { foo: 'bar' },
    });

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.get('x-device-signature')).toBeTruthy();
    expect(capturedHeaders!.get('x-device-timestamp')).toBeTruthy();
    expect(capturedHeaders!.get('x-device-nonce')).toBeTruthy();
    expect(capturedHeaders!.get('x-correlation-id')).toBeTruthy();
    expect(capturedHeaders!.get('content-type')).toBe('application/json');
  });

  it('includes Authorization header when sessionToken is set', async () => {
    let capturedHeaders: Headers | undefined;

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedHeaders = new Headers(init.headers);
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      sessionToken: 'test-session-token-123',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await client.request('/test-endpoint');
    expect(capturedHeaders!.get('authorization')).toBe('Bearer test-session-token-123');
  });

  it('successfully completes pairing handshake and sets session token', async () => {
    const mockResponse = {
      installationId: 'inst_mock_123',
      connectionId: 'conn_mock_456',
      clinicId: 'CLN-001',
      sessionToken: 'stk_mock_789',
      expiresAt: '2026-10-01T00:00:00Z',
      targetOrigin: 'http://localhost:4001',
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await client.pair('PAIR-TEST-123', 'MOCK_PUBKEY', 'Test Device');
    expect(result.installationId).toBe('inst_mock_123');
    expect(result.targetOrigin).toBe('http://localhost:4001');
    expect(client.getSessionToken()).toBe('stk_mock_789');
  });

  it('handles PAIRING_CODE_EXPIRED with descriptive classified error', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'PAIRING_CODE_EXPIRED',
          message: 'The pairing code has expired',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const client = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    try {
      await client.pair('EXPIRED', 'MOCK_PUBKEY');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LamaniError);
      expect((err as LamaniError).code).toBe('PAIRING_CODE_EXPIRED');
      expect((err as LamaniError).statusCode).toBe(400);
      expect((err as LamaniError).message).toContain('expired');
    }
  });

  it('throws CMS_SCHEMA_ERROR if pairing response schema is invalid', async () => {
    const invalidResponse = {
      installationId: 'inst_123',
      // missing connectionId, sessionToken, targetOrigin
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(invalidResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    await expect(client.pair('PAIR-123', 'PUBKEY')).rejects.toThrow(LamaniError);
  });

  it('clears session token on revoke', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'revoked' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      sessionToken: 'token-to-revoke',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(client.getSessionToken()).toBe('token-to-revoke');
    await client.revoke('inst_123');
    expect(client.getSessionToken()).toBeNull();
  });

  it('includes query parameters in canonical string and compensates for clock skew', async () => {
    let capturedHeaders: Headers | undefined;
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedHeaders = new Headers(init.headers);
      return new Response(JSON.stringify({ status: 'ok', serverTime: '2026-09-21T12:00:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // Set 1 hour forward clock skew (+3600000 ms)
    client.setClockSkew(3600000);
    const beforeReq = Date.now() + 3600000;

    await client.request('/v1/sync/connections/conn_1/adapter?variant=legacy');

    const sentTime = new Date(capturedHeaders!.get('x-device-timestamp')!).getTime();
    expect(Math.abs(sentTime - beforeReq)).toBeLessThan(5000);
    expect(capturedHeaders!.get('x-device-signature')).toBeTruthy();

    // Heartbeat updates clock skew from serverTime
    await client.heartbeat('inst_123');
    expect(client.getClockSkew()).not.toBe(0);
  });

  it('manages leader lease lifecycle: acquire, renew, and release', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/acquire')) {
        return new Response(
          JSON.stringify({
            status: 'GRANTED',
            leaseId: 'lease_mock_1',
            fencingToken: 10,
            expiresAt: new Date(Date.now() + 30000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/renew')) {
        return new Response(
          JSON.stringify({
            status: 'RENEWED',
            leaseId: 'lease_mock_1',
            fencingToken: 10,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/release')) {
        return new Response(
          JSON.stringify({ status: 'RELEASED' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    const client = new SyncApiClient({
      baseUrl: 'http://localhost:4002',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const acquired = await client.acquireLease('conn_123', 'inst_456', 30);
    expect(acquired.status).toBe('GRANTED');
    expect(acquired.leaseId).toBe('lease_mock_1');

    const renewed = await client.renewLease('conn_123', 'lease_mock_1', 10, 'inst_456', 30);
    expect(renewed.status).toBe('RENEWED');

    const released = await client.releaseLease('conn_123', 'lease_mock_1');
    expect(released.status).toBe('RELEASED');
  });
});
