import { describe, it, expect, vi } from 'vitest';
import { IdempotencyResolver } from '../../src/background/idempotency.js';

describe('Idempotency & Search-Before-Retry Resolver (Phase 8)', () => {
  it('searches and finds an existing appointment by criteria', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/appointments?providerId=DOC-01')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'APT-100',
                patientId: 'ZZTEST-P01',
                providerId: 'DOC-01',
                startTime: '2026-10-01T09:00:00+08:00',
                status: 'booked',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const resolver = new IdempotencyResolver({
      targetOrigin: 'http://localhost:4001',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const found = await resolver.searchExistingAppointment({
      patientId: 'ZZTEST-P01',
      providerId: 'DOC-01',
      startTime: '2026-10-01T09:00:00+08:00',
    });

    expect(found).not.toBeNull();
    expect(found?.id).toBe('APT-100');
  });

  it('checks slot availability before write', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          slots: [
            { startTime: '2026-10-01T09:00:00+08:00', available: false },
            { startTime: '2026-10-01T09:30:00+08:00', available: true },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const resolver = new IdempotencyResolver({
      targetOrigin: 'http://localhost:4001',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const slot1 = await resolver.checkSlotAvailability('DOC-01', '2026-10-01T09:00:00+08:00');
    expect(slot1.available).toBe(false);
    expect(slot1.reason).toContain('already booked');

    const slot2 = await resolver.checkSlotAvailability('DOC-01', '2026-10-01T09:30:00+08:00');
    expect(slot2.available).toBe(true);
  });

  it('resolves 409 conflict as idempotent success when slot already held by SAME patient', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/appointments/APT-EXISTING')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'APT-EXISTING',
              patientId: 'ZZTEST-P01', // Matching patient ID
              providerId: 'DOC-01',
              startTime: '2026-10-01T10:00:00+08:00',
              status: 'booked',
              rev: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    });

    const resolver = new IdempotencyResolver({
      targetOrigin: 'http://localhost:4001',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await resolver.resolveConflict(
      'CREATE_APPOINTMENT',
      {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T10:00:00+08:00',
      },
      {
        existingAppointmentId: 'APT-EXISTING',
      }
    );

    expect(res.isIdempotentMatch).toBe(true);
    expect(res.isConflict).toBe(false);
    expect(res.existingRecord?.id).toBe('APT-EXISTING');
  });

  it('resolves 409 conflict as TRUE conflict when slot is held by a DIFFERENT patient', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/appointments/APT-OTHER')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'APT-OTHER',
              patientId: 'ZZTEST-P99', // Different patient ID!
              providerId: 'DOC-01',
              startTime: '2026-10-01T10:00:00+08:00',
              status: 'booked',
              rev: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    });

    const resolver = new IdempotencyResolver({
      targetOrigin: 'http://localhost:4001',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const res = await resolver.resolveConflict(
      'CREATE_APPOINTMENT',
      {
        patientId: 'ZZTEST-P01', // Requesting for P01
        providerId: 'DOC-01',
        startTime: '2026-10-01T10:00:00+08:00',
      },
      {
        existingAppointmentId: 'APT-OTHER',
      }
    );

    expect(res.isIdempotentMatch).toBe(false);
    expect(res.isConflict).toBe(true);
    expect(res.reason).toBeDefined();
  });
});
