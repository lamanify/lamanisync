// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { executeRecipe } from '../../src/adapters/interpreter.js';
import { validateAdapterManifest, type AdapterManifest } from '../../src/adapters/schema.js';

describe('Declarative Interpreter Engine (interpreter.ts)', () => {
  const fixturePath = path.resolve('src/adapters/manifests/acme-cloud.json');
  const manifest: AdapterManifest = validateAdapterManifest(JSON.parse(fs.readFileSync(fixturePath, 'utf-8')));

  it('executes a declarative read recipe successfully', async () => {
    const mockFetch: typeof fetch = async (url) => {
      expect(url.toString()).toBe('http://localhost:4001/api/patients');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'ZZTEST-P01', fullName: 'Patient 1' },
            { id: 'ZZTEST-P02', fullName: 'Patient 2' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res = await executeRecipe({
      manifest,
      recipeId: 'patients_list',
      fetchFn: mockFetch,
    });

    expect(res.status).toBe('SUCCESS');
    expect(Array.isArray(res.data)).toBe(true);
    expect((res.data as Array<unknown>).length).toBe(2);
  });

  it('executes a declarative write recipe with transforms and read-after-write verification', async () => {
    let writeCalled = false;
    let verifyCalled = false;

    const mockFetch: typeof fetch = async (url, init) => {
      const urlStr = url.toString();
      if (urlStr === 'http://localhost:4001/api/patients' && init?.method === 'POST') {
        writeCalled = true;
        const body = JSON.parse(String(init.body));
        // Verify phone transform ran (normalized to +60...)
        expect(body.phone).toBe('+60123456789');
        expect(body.fullName).toBe('New Patient');

        return new Response(
          JSON.stringify({
            data: {
              id: 'ZZTEST-P99',
              fullName: body.fullName,
              phone: body.phone,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (urlStr === 'http://localhost:4001/api/patients/ZZTEST-P99' && init?.method === 'GET') {
        verifyCalled = true;
        return new Response(
          JSON.stringify({
            data: {
              id: 'ZZTEST-P99',
              fullName: 'New Patient',
              phone: '+60123456789',
              rev: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch call to ${urlStr}`);
    };

    const res = await executeRecipe({
      manifest,
      recipeId: 'patient_create',
      params: {
        fullName: '  New Patient  ',
        phone: '012-345 6789', // requires phone_my transform
      },
      fetchFn: mockFetch,
    });

    expect(res.status).toBe('SUCCESS');
    expect(writeCalled).toBe(true);
    expect(verifyCalled).toBe(true);
    expect(res.writeReceipt).toBeDefined();
    expect(res.writeReceipt?.externalId).toBe('ZZTEST-P99');
    expect(res.writeReceipt?.revision).toBe(1);
  });

  it('fails with CONFLICT when precondition is not satisfied', async () => {
    const mockFetch: typeof fetch = async (url) => {
      // Return slot not available
      if (url.toString().includes('/api/appointments/availability')) {
        return new Response(
          JSON.stringify({
            slots: [{ startTime: '2026-10-01T09:00:00+08:00', available: false }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    };

    const res = await executeRecipe({
      manifest,
      recipeId: 'appointment_create',
      params: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T09:00:00+08:00',
        endTime: '2026-10-01T09:15:00+08:00',
      },
      fetchFn: mockFetch,
    });

    expect(res.status).toBe('CONFLICT');
    expect(res.error?.code).toBe('CONFLICT');
    expect(res.error?.message).toContain('already booked');
  });

  it('fails with VERIFICATION_FAILED if read-after-write read back fails', async () => {
    const mockFetch: typeof fetch = async (url, init) => {
      const urlStr = url.toString();
      if (urlStr.includes('/api/appointments/availability')) {
        return new Response(
          JSON.stringify({ slots: [{ startTime: '2026-10-01T11:00:00+08:00', available: true }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ data: { id: 'APT-FAIL' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Verification GET returns 404
      return new Response('Not Found', { status: 404 });
    };

    const res = await executeRecipe({
      manifest,
      recipeId: 'appointment_create',
      params: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T11:00:00+08:00',
        endTime: '2026-10-01T11:15:00+08:00',
      },
      fetchFn: mockFetch,
    });

    expect(res.status).toBe('ERROR');
    expect(res.error?.code).toBe('VERIFICATION_FAILED');
  });

  it('rejects recipes not present in the manifest', async () => {
    const res = await executeRecipe({
      manifest,
      recipeId: 'unsupported_recipe_xyz',
      fetchFn: async () => new Response(''),
    });

    expect(res.status).toBe('ERROR');
    expect(res.error?.code).toBe('UNSUPPORTED_RECIPE_ID');
  });

  it('rejects recipes when manifest lacks the required capability', async () => {
    // Clone manifest without APPOINTMENT_WRITE capability
    const restrictedManifest: AdapterManifest = {
      ...manifest,
      capabilities: ['PATIENT_READ'],
    };

    const res = await executeRecipe({
      manifest: restrictedManifest,
      recipeId: 'appointment_create',
      fetchFn: async () => new Response(''),
    });

    expect(res.status).toBe('ERROR');
    expect(res.error?.code).toBe('MISSING_CAPABILITY');
  });

  it('maps HTTP 404 status from CMS to NOT_FOUND error code', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ message: 'Patient not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const res = await executeRecipe({
      manifest,
      recipeId: 'patients_get',
      params: { id: 'NONEXISTENT' },
      fetchFn: mockFetch,
    });

    expect(res.status).toBe('ERROR');
    expect(res.error?.code).toBe('NOT_FOUND');
    expect(res.error?.message).toBe('Patient not found');
  });

  it('ensures non-CSRF hooks like acme-format-display-time do not pollute X-CSRF-Token header', async () => {
    let observedHeaders: Record<string, string> = {};
    const mockFetch: typeof fetch = async (_url, init) => {
      observedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    // Construct a recipe referencing acme-format-display-time hook
    const hookedManifest: AdapterManifest = {
      ...manifest,
      recipes: {
        ...manifest.recipes,
        hooked_read: {
          recipeId: 'hooked_read',
          type: 'read',
          capability: 'APPOINTMENT_READ',
          method: 'GET',
          path: '/api/appointments',
          hook: 'acme-format-display-time',
        },
      },
    };

    const params: Record<string, unknown> = { startTime: '2026-10-01T09:30:00+08:00' };
    const res = await executeRecipe({
      manifest: hookedManifest,
      recipeId: 'hooked_read',
      params,
      fetchFn: mockFetch,
    });

    expect(res.status).toBe('SUCCESS');
    expect(observedHeaders['X-CSRF-Token']).toBeUndefined();
    expect(params.displayTime).toBe('01/10/2026 09:30 AM');
  });
});
