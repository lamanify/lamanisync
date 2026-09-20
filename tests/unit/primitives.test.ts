// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  transformTrim,
  transformIsoDate,
  transformPhoneMy,
  transformLowercase,
  transformUppercase,
  transformInteger,
  applyTransform,
  isAllowlistedTransform,
} from '../../src/adapters/primitives/transforms.js';
import { extractField } from '../../src/adapters/primitives/field-extractor.js';
import {
  interpolatePath,
  matchPath,
  validateParameterValue,
} from '../../src/adapters/primitives/matchers.js';
import {
  evaluatePrecondition,
  assertPreconditions,
} from '../../src/adapters/primitives/preconditions.js';
import { executeWriteVerification } from '../../src/adapters/primitives/verification.js';
import { LamaniError, ConflictError } from '../../src/core/errors.js';

describe('Declarative Primitives (Phase 6)', () => {
  describe('Transforms', () => {
    it('normalizes Malaysian phone numbers accurately', () => {
      expect(transformPhoneMy('012-345 6789')).toBe('+60123456789');
      expect(transformPhoneMy('60123456789')).toBe('+60123456789');
      expect(transformPhoneMy('+60123456789')).toBe('+60123456789');
      expect(transformPhoneMy('01987654321')).toBe('+601987654321');

      // Invalid Malaysian numbers fail
      expect(() => transformPhoneMy('12345')).toThrowError(LamaniError);
      expect(() => transformPhoneMy('+1-202-555-0125')).toThrowError(LamaniError);
    });

    it('parses dates to ISO-8601 string', () => {
      const iso = transformIsoDate('2026-10-01T09:00:00+08:00');
      expect(iso).toContain('2026-10-01');
      expect(() => transformIsoDate('invalid-date-string')).toThrowError(LamaniError);
    });

    it('trims whitespace and changes casing', () => {
      expect(transformTrim('   Alice Doe   ')).toBe('Alice Doe');
      expect(transformLowercase('HELLO')).toBe('hello');
      expect(transformUppercase('hello')).toBe('HELLO');
      expect(transformInteger('42')).toBe(42);
      expect(() => transformInteger('abc')).toThrowError(LamaniError);
    });

    it('strictly allowlists transforms and rejects unknown primitives', () => {
      expect(isAllowlistedTransform('trim')).toBe(true);
      expect(isAllowlistedTransform('phone_my')).toBe(true);
      expect(isAllowlistedTransform('__UNKNOWN_EVAL__')).toBe(false);

      expect(() => applyTransform('__UNKNOWN_EVAL__', 'test')).toThrowError(LamaniError);
      expect(() => applyTransform('__UNKNOWN_EVAL__', 'test')).toThrowError(/not an allowlisted primitive/);
    });
  });

  describe('Field Extractor', () => {
    const testData = {
      response: {
        status: 'ok',
        data: {
          appointments: [
            { id: 'APT-001', rev: 1, doctor: { name: 'Dr. Alice' } },
            { id: 'APT-002', rev: 2, doctor: { name: 'Dr. Bob' } },
          ],
          count: 2,
        },
      },
    };

    it('extracts nested fields using dot notation', () => {
      expect(extractField(testData, 'response.status')).toBe('ok');
      expect(extractField(testData, 'response.data.count')).toBe(2);
      expect(extractField(testData, 'response.data.appointments.0.id')).toBe('APT-001');
      expect(extractField(testData, 'response.data.nonexistent')).toBeUndefined();
    });

    it('extracts array wildcards (response.data.appointments[].id)', () => {
      const ids = extractField(testData, 'response.data.appointments[].id');
      expect(ids).toEqual(['APT-001', 'APT-002']);

      const doctorNames = extractField(testData, 'response.data.appointments[].doctor.name');
      expect(doctorNames).toEqual(['Dr. Alice', 'Dr. Bob']);
    });

    it('strictly blocks prototype pollution attempts (__proto__, constructor, prototype)', () => {
      expect(() => extractField(testData, '__proto__.polluted')).toThrowError(LamaniError);
      expect(() => extractField(testData, 'response.constructor.name')).toThrowError(LamaniError);
      expect(() => extractField(testData, 'prototype.evil')).toThrowError(LamaniError);
    });

    it('returns undefined for inherited Object.prototype methods and invalid array indices', () => {
      expect(extractField({}, 'toString')).toBeUndefined();
      expect(extractField({}, 'valueOf')).toBeUndefined();
      expect(extractField(['a', 'b'], '0.5')).toBeUndefined();
      expect(extractField(['a', 'b'], '0abc')).toBeUndefined();
    });

    it('enforces complexity bounds on path depth and nested wildcards', () => {
      const deepPath = 'a.b.c.d.e.f.g.h.i.j.k.l';
      expect(() => extractField(testData, deepPath)).toThrowError(/exceeds maximum complexity limit/);

      expect(() => extractField(testData, 'a[].b[].c')).toThrowError(/Nested array wildcards/);
    });
  });

  describe('URL & Method Matchers', () => {
    it('interpolates path parameters safely', () => {
      const path = interpolatePath('/api/patients/:id', { id: 'ZZTEST-P01' });
      expect(path).toBe('/api/patients/ZZTEST-P01');

      const complex = interpolatePath('/api/:module/:id/sub', { module: 'appointments', id: 'APT-001' });
      expect(complex).toBe('/api/appointments/APT-001/sub');
    });

    it('strictly blocks path traversals, slashes, and injection in parameter values', () => {
      expect(() => validateParameterValue('id', '../../etc/passwd')).toThrowError(/unsafe characters/);
      expect(() => validateParameterValue('id', 'admin/secret')).toThrowError(/unsafe characters/);
      expect(() => validateParameterValue('id', 'foo\\bar')).toThrowError(/unsafe characters/);
      expect(() => validateParameterValue('id', 'test\x00evil')).toThrowError(/unsafe characters/);
      expect(() => validateParameterValue('id', '')).toThrowError(/cannot be empty/);
      expect(() => validateParameterValue('id', { evil: true })).toThrowError(/must be a primitive value/);
      expect(() => validateParameterValue('id', () => {})).toThrowError(/must be a primitive value/);
    });

    it('matches path template and extracts parameters in linear time', () => {
      const match = matchPath('/api/appointments/:id', '/api/appointments/APT-001');
      expect(match.matches).toBe(true);
      expect(match.params).toEqual({ id: 'APT-001' });

      // Matches even if template has query string attached
      const matchQuery = matchPath('/api/appointments/:id?filter=all', '/api/appointments/APT-001?foo=bar');
      expect(matchQuery.matches).toBe(true);
      expect(matchQuery.params).toEqual({ id: 'APT-001' });

      const mismatch = matchPath('/api/appointments/:id', '/api/patients/APT-001');
      expect(mismatch.matches).toBe(false);
    });
  });

  describe('Preconditions', () => {
    it('evaluates field_equals precondition correctly', async () => {
      const prec = {
        type: 'field_equals' as const,
        path: 'status',
        expected: 'booked',
      };

      const pass = await evaluatePrecondition(prec, { params: { status: 'booked' } });
      expect(pass.satisfied).toBe(true);

      const fail = await evaluatePrecondition(prec, { params: { status: 'cancelled' } });
      expect(fail.satisfied).toBe(false);
      expect(fail.reason).toContain("expected 'booked'");
    });

    it('evaluates slot_availability precondition against availability mock endpoint', async () => {
      const mockFetch: typeof fetch = async (url) => {
        const u = new URL(url.toString());
        expect(u.searchParams.get('providerId')).toBe('DOC-01');
        return new Response(
          JSON.stringify({
            slots: [
              { startTime: '2026-10-01T09:00:00+08:00', available: true },
              { startTime: '2026-10-01T09:30:00+08:00', available: false },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const prec = {
        type: 'slot_availability' as const,
        endpoint: '/api/appointments/availability',
      };

      // Available slot passes
      const pass = await evaluatePrecondition(prec, {
        params: { providerId: 'DOC-01', startTime: '2026-10-01T09:00:00+08:00' },
        baseOrigin: 'http://localhost:4001',
        fetchFn: mockFetch,
      });
      expect(pass.satisfied).toBe(true);

      // Booked slot fails
      const fail = await evaluatePrecondition(prec, {
        params: { providerId: 'DOC-01', startTime: '2026-10-01T09:30:00+08:00' },
        baseOrigin: 'http://localhost:4001',
        fetchFn: mockFetch,
      });
      expect(fail.satisfied).toBe(false);
      expect(fail.reason).toContain('is already booked');

      // assertPreconditions throws ConflictError on failure
      await expect(
        assertPreconditions([prec], {
          params: { providerId: 'DOC-01', startTime: '2026-10-01T09:30:00+08:00' },
          baseOrigin: 'http://localhost:4001',
          fetchFn: mockFetch,
        })
      ).rejects.toThrowError(ConflictError);
    });

    it('rejects unknown precondition types', async () => {
      const unknownPrec = {
        type: 'dangerous_eval' as unknown as 'field_equals',
        path: 'foo',
        expected: 'bar',
      };

      await expect(evaluatePrecondition(unknownPrec, { params: {} })).rejects.toMatchObject({
        code: 'UNKNOWN_PRIMITIVE',
      });
    });
  });

  describe('Read-After-Write Verification (Rule 10)', () => {
    it('successfully queries back written entity by ID and confirms field match', async () => {
      const mockFetch: typeof fetch = async (url) => {
        expect(url.toString()).toBe('http://localhost:4001/api/appointments/APT-999');
        return new Response(
          JSON.stringify({
            data: {
              id: 'APT-999',
              patientId: 'ZZTEST-P01',
              providerId: 'DOC-01',
              status: 'booked',
              rev: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const recipe = {
        path: '/api/appointments/:id',
        expectedFields: {
          patientId: '$params.patientId',
          status: 'booked',
        },
        revisionPath: 'rev',
      };

      const receipt = await executeWriteVerification(recipe, {
        baseOrigin: 'http://localhost:4001',
        params: { patientId: 'ZZTEST-P01', providerId: 'DOC-01' },
        writeResponseData: { id: 'APT-999' },
        fetchFn: mockFetch,
      });

      expect(receipt.externalId).toBe('APT-999');
      expect(receipt.revision).toBe(1);
      expect(receipt.verifiedAt).toBeDefined();
    });

    it('fails when read back status is non-200 or fields mismatch', async () => {
      const notFoundFetch: typeof fetch = async () => new Response('Not found', { status: 404 });

      await expect(
        executeWriteVerification(
          { path: '/api/appointments/:id' },
          {
            baseOrigin: 'http://localhost:4001',
            params: {},
            writeResponseData: { id: 'APT-999' },
            fetchFn: notFoundFetch,
          }
        )
      ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });

      // Field mismatch fetch
      const mismatchFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({ data: { id: 'APT-999', status: 'cancelled' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

      await expect(
        executeWriteVerification(
          {
            path: '/api/appointments/:id',
            expectedFields: { status: 'booked' },
          },
          {
            baseOrigin: 'http://localhost:4001',
            params: {},
            writeResponseData: { id: 'APT-999' },
            fetchFn: mismatchFetch,
          }
        )
      ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    });

    it('considers equivalent dates in different timezone offsets as matching and forwards headers', async () => {
      let forwardedHeader: string | null = null;
      const mockFetch: typeof fetch = async (_url, init) => {
        forwardedHeader = (init?.headers as Record<string, string>)?.['X-Custom-Auth'] || null;
        return new Response(
          JSON.stringify({
            data: {
              id: 'APT-999',
              startTime: '2026-10-01T06:30:00.000Z', // UTC equivalent of 14:30:00+08:00
              rev: '2', // string revision parsed to number
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const recipe = {
        path: '/api/appointments/:id',
        expectedFields: {
          startTime: '$params.startTime',
        },
      };

      const receipt = await executeWriteVerification(recipe, {
        baseOrigin: 'http://localhost:4001',
        params: { startTime: '2026-10-01T14:30:00+08:00' },
        writeResponseData: { id: 'APT-999' },
        headers: { 'X-Custom-Auth': 'secret-staff-token' },
        fetchFn: mockFetch,
      });

      expect(receipt.externalId).toBe('APT-999');
      expect(receipt.revision).toBe(2);
      expect(forwardedHeader).toBe('secret-staff-token');
    });
  });
});
