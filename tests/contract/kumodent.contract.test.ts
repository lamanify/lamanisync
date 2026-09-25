// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { executeRecipe } from '../../src/adapters/interpreter.js';
import { validateAdapterManifest, type AdapterManifest } from '../../src/adapters/schema.js';
import { verifyManifestStrict } from '../../src/adapters/verifier.js';
import {
  kumodentExtractCsrf,
  kumodentInjectAuth,
  kumodentConflictParams,
  KUMODENT_SECONDARY_API_ORIGIN,
} from '../../src/adapters/packaged-hooks/kumodent-hooks.js';
import {
  executePredefinedAction,
  ACTION_APPOINTMENT_CREATE,
  ACTION_APPOINTMENT_RESCHEDULE,
  ACTION_APPOINTMENT_CANCEL,
  ACTION_APPOINTMENT_VERIFY,
  ACTION_PATIENT_CREATE,
  ACTION_PATIENT_VERIFY,
  ACTION_CATALOG_IMPORT,
} from '../../src/page/action-runner.js';

describe('KumoDent Adapter Contract Tests', () => {
  const manifestPath = path.resolve('src/adapters/manifests/kumodent.json');
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  let manifest: AdapterManifest;

  const MOCK_TOKEN = 'mock-kumodent-token-abc123xyz';
  const MOCK_CSRF = 'csrf-token-laravel-meta-123';

  // Mock document and storage for ambient session simulation
  const mockDocument = {
    querySelector: (selector: string) => {
      if (selector === 'meta[name="_token"]') {
        return { getAttribute: (attr: string) => (attr === 'content' ? MOCK_CSRF : null) };
      }
      return null;
    },
  } as unknown as Document;

  const mockStorage = {
    getItem: (key: string) => {
      if (key === 'auth_jsn') {
        return JSON.stringify({
          token: MOCK_TOKEN,
          user: {
            selectedSite: { iid: 1, firstName: 'KP HANA SG BULOH', nickName: 'KPH' },
            sites: [{ iid: 1, firstName: 'KP HANA SG BULOH', nickName: 'KPH' }],
          },
        });
      }
      return null;
    },
  };

  // Mock state for KumoDent backend
  interface MockDb {
    patients: Array<Record<string, unknown>>;
    appointments: Array<Record<string, unknown>>;
    employees: Array<Record<string, unknown>>;
  }

  let db: MockDb;
  let activeFault: string = 'none';

  beforeAll(async () => {
    // 1. Verify Ed25519 signature validity and strict schema compliance
    await verifyManifestStrict(manifestJson);
    manifest = validateAdapterManifest(manifestJson);
  });

  beforeEach(() => {
    activeFault = 'none';
    db = {
      patients: [
        {
          id: 'ZZTEST-KUMO-P01',
          fullName: 'Siti Nurhaliza',
          phone: '+60123456701',
          email: 'siti@example.test',
          icOrPassport: '900101-14-5001',
        },
      ],
      appointments: [
        {
          id: 'KUMO-APT-01',
          patientId: 'ZZTEST-KUMO-P01',
          staffId: 'STAFF-01',
          date: '2026-10-01',
          startTime: '2026-10-01T09:00:00',
          endTime: '2026-10-01T09:30:00',
          status: 'booked',
          rev: 1,
        },
      ],
      employees: [
        { id: 'STAFF-01', iid: 11, name: 'Dr. Hana Dentist', role: 'Doctor', status: 1 },
        { id: 'STAFF-02', iid: 25, name: 'Dr. Daniel Orthodontist', role: 'Doctor', status: 1 },
      ],
    };
  });

  // Mock Fetch Router simulating both Laravel V1 and Node V2 Azure APIs
  const mockFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : (input as Request).url;
    const parsed = new URL(urlStr);
    const method = (init?.method || 'GET').toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;

    // Fault injection
    if (activeFault === '401') {
      return new Response(JSON.stringify({ message: 'Session expired or unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (activeFault === '403') {
      return new Response(JSON.stringify({ message: 'Unauthorized staff action' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (activeFault === '409') {
      return new Response(JSON.stringify({ message: 'Staff schedule conflict' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (activeFault === '429') {
      return new Response(JSON.stringify({ message: 'Rate limited by KumoDent' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (activeFault === '500') {
      return new Response(JSON.stringify({ message: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- Node V2 Endpoints (on Azure Secondary API) ---
    // Requires x-aoikumo-access-token header
    if (urlStr.includes('/api/scheduler/post/appointmentlist') || parsed.pathname === '/api/scheduler/post/appointmentlist' || parsed.pathname === '/scheduler/post/appointmentlist') {
      if (method === 'POST') {
        expect(headers['x-aoikumo-access-token']).toBe(`Token ${MOCK_TOKEN}`);
        return new Response(JSON.stringify({ status: 1, data: db.appointments }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (urlStr.includes('/api/scheduler/post/employeelist') || parsed.pathname === '/api/scheduler/post/employeelist' || parsed.pathname === '/scheduler/post/employeelist') {
      if (method === 'POST') {
        expect(headers['x-aoikumo-access-token']).toBe(`Token ${MOCK_TOKEN}`);
        return new Response(JSON.stringify({ status: 1, data: db.employees }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (urlStr.includes('/service/products/getajaxservicemergednew')) {
      if (method === 'POST') {
        expect(headers['x-aoikumo-access-token']).toBe(`Token ${MOCK_TOKEN}`);
        return new Response(JSON.stringify({
          status: 1,
          recordsTotal: 2,
          data: [
            { serviceId: 63, serviceSku: '2NDBC', serviceType: 'ORTHODONTIC', serviceName: '2ND CONSULTATION BRACES', priceEnd: 1000, duration: 1800 },
            { serviceId: 10194, serviceSku: 'ABCU', serviceType: 'CHECK UP', serviceName: 'ABSCESS', priceEnd: 100, duration: 900 }
          ]
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (urlStr.includes('/api/customer/getuserdata/') || parsed.pathname.startsWith('/api/customer/getuserdata/')) {
      if (method === 'GET') {
        expect(headers['x-aoikumo-access-token']).toBe(`Token ${MOCK_TOKEN}`);
        const id = parsed.pathname.split('/').pop();
        const found = db.patients.find((p) => p.id === id);
        if (!found) {
          return new Response(JSON.stringify({ message: 'Patient not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ status: 1, data: found }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // --- Laravel V1 Endpoints (on Primary Origin) ---
    // Requires ambient CSRF token header
    if (parsed.pathname === '/customer/newcustomer') {
      if (method === 'POST') {
        expect(headers['X-CSRF-TOKEN'] || headers['X-CSRF-Token']).toBe(MOCK_CSRF);
        const body = JSON.parse(init?.body as string);
        const newPatient = {
          id: `ZZTEST-KUMO-P${Date.now()}`,
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          icOrPassport: body.icOrPassport,
        };
        db.patients.push(newPatient);
        return new Response(JSON.stringify({ status: 1, data: newPatient, id: newPatient.id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (parsed.pathname.startsWith('/appointment/checkstaffappointmenthasconflictwa/')) {
      if (method === 'GET') {
        // e.g. /appointment/checkstaffappointmenthasconflictwa/:staffId/:date/:start/:end/:id
        // segments: [0] appointment, [1] checkstaffappointmenthasconflictwa, [2] staffId, [3] date, [4] start, [5] end, [6] id
        const segments = parsed.pathname.split('/').filter(Boolean);
        const staffId = decodeURIComponent(segments[2] || '');
        const date = decodeURIComponent(segments[3] || '');
        const start = decodeURIComponent(segments[4] || '');

        const hasConflict = db.appointments.some(
          (a) => a.staffId === staffId && a.date === date && String(a.startTime).includes(start)
        );

        return new Response(
          JSON.stringify({ status: 1, conflict: hasConflict, data: { conflict: hasConflict, hasConflict } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    if (parsed.pathname === '/appointment/createV2wa_temp') {
      if (method === 'POST') {
        expect(headers['X-CSRF-TOKEN'] || headers['X-CSRF-Token']).toBe(MOCK_CSRF);
        const body = JSON.parse(init?.body as string);
        if (body.notes === 'trigger_room_unavailable') {
          return new Response('Room not available', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        const newAppt = {
          id: `KUMO-APT-${Date.now()}`,
          patientId: body.patientId,
          staffId: body.staffId,
          date: body.date,
          startTime: body.startTime,
          endTime: body.endTime,
          notes: body.notes,
          status: 'booked',
          rev: 1,
        };
        db.appointments.push(newAppt);
        return new Response(JSON.stringify({ status: 1, data: newAppt, id: newAppt.id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (parsed.pathname === '/scheduler/updateappointmentwa_temp') {
      if (method === 'POST') {
        expect(headers['X-CSRF-TOKEN'] || headers['X-CSRF-Token']).toBe(MOCK_CSRF);
        const body = JSON.parse(init?.body as string);
        const existing = db.appointments.find((a) => a.id === body.id);
        if (!existing) {
          return new Response(JSON.stringify({ message: 'Appointment not found' }), { status: 404 });
        }
        if (body.date) existing.date = body.date;
        if (body.startTime) existing.startTime = body.startTime;
        if (body.endTime) existing.endTime = body.endTime;
        if (body.notes) existing.notes = body.notes;
        existing.rev = Number(existing.rev || 1) + 1;
        return new Response(JSON.stringify({ status: 1, data: existing, id: existing.id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (parsed.pathname === '/scheduler/updateappointmentstatuswa') {
      if (method === 'POST') {
        expect(headers['X-CSRF-TOKEN'] || headers['X-CSRF-Token']).toBe(MOCK_CSRF);
        const body = JSON.parse(init?.body as string);
        const existing = db.appointments.find((a) => a.id === body.id);
        if (!existing) {
          return new Response(JSON.stringify({ message: 'Appointment not found' }), { status: 404 });
        }
        existing.status = body.status || 'cancelled';
        existing.rev = Number(existing.rev || 1) + 1;
        return new Response(JSON.stringify({ status: 1, data: existing, id: existing.id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (parsed.pathname.startsWith('/scheduler/geteventdatawa/')) {
      if (method === 'GET') {
        const id = parsed.pathname.split('/').pop();
        const found = db.appointments.find((a) => a.id === id);
        if (!found) {
          return new Response(JSON.stringify({ message: 'Appointment not found' }), { status: 404 });
        }
        return new Response(JSON.stringify({ status: 1, data: found }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ message: `Not Found: ${urlStr}` }), { status: 404 });
  };

  describe('Section 1: Manifest Cryptographic & Complexity Certification', () => {
    it('verifies Ed25519 signature validity and strict schema compliance', async () => {
      expect(manifest.adapterId).toBe('kumodent');
      expect(manifest.name).toBe('KumoDent Dental CMS Certified Adapter');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.targetOrigin).toBe('https://hanadental.aoikumo.com');
      expect(manifest.signature).toBeDefined();

      // Complexity checks
      const recipeKeys = Object.keys(manifest.recipes || {});
      expect(recipeKeys.length).toBeGreaterThanOrEqual(10);
      expect(recipeKeys.length).toBeLessThanOrEqual(50);

      // Verify all required capabilities are declared
      const requiredCaps = [
        'PATIENT_READ',
        'PATIENT_WRITE',
        'APPOINTMENT_READ',
        'APPOINTMENT_WRITE',
        'REFERENCE_DATA_READ',
        'patients.read',
        'patients.create',
        'appointments.read',
        'appointments.availability',
        'appointments.create',
        'appointments.reschedule',
        'appointments.cancel',
        'reference.read',
      ];
      for (const cap of requiredCaps) {
        expect(manifest.capabilities).toContain(cap);
      }
    });

    it('rejects tampered manifest payloads', async () => {
      const tampered = { ...manifestJson, adapterId: 'kumodent-tampered' };
      await expect(verifyManifestStrict(tampered)).rejects.toThrow();
    });
  });

  describe('Section 2: Packaged Hooks Verification', () => {
    it('extracts CSRF token using kumodentExtractCsrf', () => {
      const headers: Record<string, string> = {};
      const token = kumodentExtractCsrf({ document: mockDocument, headers });
      expect(token).toBe(MOCK_CSRF);
      expect(headers['X-CSRF-TOKEN']).toBe(MOCK_CSRF);
      expect(headers['X-CSRF-Token']).toBe(MOCK_CSRF);
    });

    it('injects Node V2 auth token and resolves Azure Secondary API origin using kumodentInjectAuth', () => {
      const headers: Record<string, string> = {};
      const result = kumodentInjectAuth({
        storage: mockStorage,
        headers,
        targetOrigin: 'https://hanadental.aoikumo.com',
      });

      expect(typeof result).toBe('object');
      const resObj = result as { headers: Record<string, string>; baseOrigin: string };
      expect(resObj.headers['x-aoikumo-access-token']).toBe(`Token ${MOCK_TOKEN}`);
      expect(resObj.baseOrigin).toBe(KUMODENT_SECONDARY_API_ORIGIN);
    });

    it('extracts CSRF token using kumodentExtractCsrf with ambient document fallback', () => {
      // Simulate ambient browser context where document is global
      const originalDoc = (globalThis as unknown as { document?: Document }).document;
      try {
        (globalThis as unknown as { document: Document }).document = mockDocument;
        const headers: Record<string, string> = {};
        // Omit document in options - should automatically resolve global document
        const token = kumodentExtractCsrf({ headers });
        expect(token).toBe(MOCK_CSRF);
        expect(headers['X-CSRF-TOKEN']).toBe(MOCK_CSRF);
      } finally {
        (globalThis as unknown as { document?: Document }).document = originalDoc;
      }
    });

    it('injects Node V2 auth token from sessionStorage and nested shapes using kumodentInjectAuth', () => {
      // Test nested token shape
      const nestedStorage = {
        getItem: (key: string) => {
          if (key === 'auth_jsn') {
            return JSON.stringify({ user: { token: 'nested-token-999' } });
          }
          return null;
        },
      };

      const headers: Record<string, string> = {};
      const result = kumodentInjectAuth({
        storage: nestedStorage,
        headers,
        targetOrigin: 'https://hanadental.aoikumo.com',
      });

      expect(typeof result).toBe('object');
      const resObj = result as { headers: Record<string, string>; baseOrigin: string };
      expect(resObj.headers['x-aoikumo-access-token']).toBe('Token nested-token-999');
      expect(resObj.baseOrigin).toBe(KUMODENT_SECONDARY_API_ORIGIN);
    });

    it('normalizes conflict check parameters and computes dynamic end time when endTime is omitted', () => {
      const params: Record<string, unknown> = {
        providerId: 'STAFF-02',
        startTime: '2026-10-05T14:15:00+08:00',
        // endTime omitted
      };
      kumodentConflictParams({ params });
      expect(params.staffId).toBe('STAFF-02');
      expect(params.date).toBe('2026-10-05');
      expect(params.start).toBe('14:15');
      expect(params.end).toBe('14:45'); // Dynamic calculation 14:15 + 30 mins
      expect(params.id).toBe('0');
    });
  });

  describe('Section 3: Read Recipes Contract Verification', () => {
    it('executes appointments.read recipe via Node V2 secondary API', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments.read',
        fetchFn: mockFetch,
        storage: mockStorage,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const appts = res.data as Array<{ id: string; patientId: string }>;
      expect(appts.length).toBe(1);
      expect(appts[0].id).toBe('KUMO-APT-01');
    });

    it('executes reference_providers recipe via Node V2 secondary API', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'reference_providers',
        fetchFn: mockFetch,
        storage: mockStorage,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const employees = res.data as Array<{ id: string; name: string }>;
      expect(employees.length).toBe(2);
      expect(employees[0].id).toBe('STAFF-01');
      expect(employees[0].name).toBe('Dr. Hana Dentist');
    });

    it('executes patients.read / patients_get recipe via Node V2 secondary API', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients_get',
        params: { id: 'ZZTEST-KUMO-P01' },
        fetchFn: mockFetch,
        storage: mockStorage,
      });

      expect(res.status).toBe('SUCCESS');
      const patient = res.data as { id: string; fullName: string };
      expect(patient.id).toBe('ZZTEST-KUMO-P01');
      expect(patient.fullName).toBe('Siti Nurhaliza');
    });

    it('executes appointments.availability conflict check recipe via Laravel V1 API', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments.availability',
        params: {
          staffId: 'STAFF-01',
          date: '2026-10-01',
          start: '09:00',
          end: '09:30',
          id: '0',
        },
        fetchFn: mockFetch,
        document: mockDocument,
      });

      expect(res.status).toBe('SUCCESS');
      const data = res.data as { conflict: boolean };
      expect(data.conflict).toBe(true);
    });
  });

  describe('Section 4: Write Lifecycle & Read-After-Write Verification (Rule 10)', () => {
    it('creates patient with phone_my normalization and read-back verification', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients.create',
        params: {
          fullName: 'Ahmad Albab',
          phone: '012-345 6789', // Should normalize to +60123456789
          email: 'albab@example.test',
          icOrPassport: '950101-14-1234',
        },
        fetchFn: mockFetch,
        document: mockDocument,
        storage: mockStorage,
      });

      expect(res.status).toBe('SUCCESS');
      expect(res.writeReceipt).toBeDefined();
      expect(res.writeReceipt?.externalId).toMatch(/^ZZTEST-KUMO-P/);

      const verified = res.writeReceipt?.data as { fullName: string; phone: string };
      expect(verified.fullName).toBe('Ahmad Albab');
      expect(verified.phone).toBe('+60123456789');
    });

    it('executes full appointment write lifecycle: create, reschedule, cancel', async () => {
      // 1. Create appointment
      const createRes = await executeRecipe({
        manifest,
        recipeId: 'appointments.create',
        params: {
          patientId: 'ZZTEST-KUMO-P01',
          staffId: 'STAFF-01',
          date: '2026-10-02',
          startTime: '2026-10-02T10:00:00',
          endTime: '2026-10-02T10:30:00',
          notes: 'Routine Dental Scaling',
        },
        fetchFn: mockFetch,
        document: mockDocument,
      });

      expect(createRes.status).toBe('SUCCESS');
      expect(createRes.writeReceipt).toBeDefined();
      const apptId = createRes.writeReceipt!.externalId;
      expect(createRes.writeReceipt?.revision).toBe(1);

      // 2. Reschedule appointment
      const reschedRes = await executeRecipe({
        manifest,
        recipeId: 'appointments.reschedule',
        params: {
          id: apptId,
          date: '2026-10-03',
          startTime: '2026-10-03T11:00:00',
          endTime: '2026-10-03T11:30:00',
          notes: 'Rescheduled Dental Scaling',
        },
        fetchFn: mockFetch,
        document: mockDocument,
      });

      expect(reschedRes.status).toBe('SUCCESS');
      expect(reschedRes.writeReceipt?.externalId).toBe(apptId);
      expect(reschedRes.writeReceipt?.revision).toBe(2);

      // 3. Cancel appointment
      const cancelRes = await executeRecipe({
        manifest,
        recipeId: 'appointments.cancel',
        params: {
          id: apptId,
          status: 'cancelled',
        },
        fetchFn: mockFetch,
        document: mockDocument,
      });

      expect(cancelRes.status).toBe('SUCCESS');
      expect(cancelRes.writeReceipt?.externalId).toBe(apptId);
      expect(cancelRes.writeReceipt?.revision).toBe(3);
    });
  });

  describe('Section 5: Fault Injection & Error Handling', () => {
    it('handles 401 Session Expiry cleanly without data corruption', async () => {
      activeFault = '401';
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments.read',
        fetchFn: mockFetch,
        storage: mockStorage,
      });

      expect(res.status).toBe('ERROR');
      expect(res.error?.code).toBe('UNAUTHORIZED');
    });

    it('handles 403 Forbidden cleanly', async () => {
      activeFault = '403';
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments.read',
        fetchFn: mockFetch,
        storage: mockStorage,
      });

      expect(res.status).toBe('ERROR');
      expect(res.error?.code).toBe('FORBIDDEN');
    });

    it('handles 409 Conflict cleanly', async () => {
      activeFault = '409';
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments.read',
        fetchFn: mockFetch,
        storage: mockStorage,
      });

      expect(res.status).toBe('CONFLICT');
    });

    it('blocks confirmation when read-back verification fails (Rule 10)', async () => {
      // Simulate verification read failure by mutating read handler
      const failingFetch: typeof fetch = async (input, init) => {
        const urlStr = typeof input === 'string' ? input : (input as Request).url;
        if (urlStr.includes('/scheduler/geteventdatawa/')) {
          return new Response(JSON.stringify({ message: 'Read verification failed' }), { status: 500 });
        }
        return mockFetch(input, init);
      };

      const bookingAttempt = await executeRecipe({
        manifest,
        recipeId: 'appointments.create',
        params: {
          patientId: 'ZZTEST-KUMO-P01',
          staffId: 'STAFF-01',
          date: '2026-10-05',
          startTime: '2026-10-05T15:00:00',
          endTime: '2026-10-05T15:30:00',
          notes: 'Unverified Booking Attempt',
        },
        fetchFn: failingFetch,
        document: mockDocument,
      });

      expect(bookingAttempt.status).toBe('ERROR');
      expect(bookingAttempt.error?.code).toBe('VERIFICATION_FAILED');
      expect(bookingAttempt.writeReceipt).toBeUndefined();
    });
  });

  describe('Section 6: Predefined Action Runner & Page-World Execution', () => {
    it('executes ACTION_APPOINTMENT_CREATE in MAIN world using KumoDent adapter routing', async () => {
      const mockWindow = {
        document: mockDocument,
        localStorage: mockStorage,
        location: { origin: 'https://hanadental.aoikumo.com', hostname: 'hanadental.aoikumo.com' },
      } as unknown as Window;

      const res = await executePredefinedAction({
        actionId: ACTION_APPOINTMENT_CREATE,
        correlationId: 'cmd-kumo-create-1',
        parameters: {
          patientId: 'ZZTEST-KUMO-P01',
          providerId: 'STAFF-01',
          startTime: '2026-10-06T14:00:00+08:00',
          endTime: '2026-10-06T14:30:00+08:00',
          notes: 'Predefined action runner test booking',
        },
        fetchFn: mockFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(res.status).toBe('SUCCESS');
      const data = res.data as { id: string; status: string; providerId: string; patientId: string };
      expect(data.id).toMatch(/^KUMO-APT-/);
      expect(data.status).toBe('booked');
      expect(data.providerId).toBe('STAFF-01');
      expect(data.patientId).toBe('ZZTEST-KUMO-P01');
    });

    it('executes ACTION_APPOINTMENT_RESCHEDULE and ACTION_APPOINTMENT_CANCEL via KumoDent routing', async () => {
      const mockWindow = {
        document: mockDocument,
        localStorage: mockStorage,
        location: { origin: 'https://hanadental.aoikumo.com', hostname: 'hanadental.aoikumo.com' },
      } as unknown as Window;

      // 1. Reschedule
      const reschedRes = await executePredefinedAction({
        actionId: ACTION_APPOINTMENT_RESCHEDULE,
        correlationId: 'cmd-kumo-resched-1',
        parameters: {
          appointmentId: 'KUMO-APT-01',
          startTime: '2026-10-07T15:00:00+08:00',
          endTime: '2026-10-07T15:30:00+08:00',
          notes: 'Rescheduled via predefined runner',
        },
        fetchFn: mockFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(reschedRes.status).toBe('SUCCESS');
      const reschedData = reschedRes.data as { id: string; rev: number };
      expect(reschedData.id).toBe('KUMO-APT-01');
      expect(reschedData.rev).toBe(2);

      // 2. Cancel
      const cancelRes = await executePredefinedAction({
        actionId: ACTION_APPOINTMENT_CANCEL,
        correlationId: 'cmd-kumo-cancel-1',
        parameters: {
          appointmentId: 'KUMO-APT-01',
          status: 'cancelled',
        },
        fetchFn: mockFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(cancelRes.status).toBe('SUCCESS');
      const cancelData = cancelRes.data as { id: string; status: string };
      expect(cancelData.id).toBe('KUMO-APT-01');
      expect(cancelData.status).toBe('cancelled');
    });

    it('executes ACTION_APPOINTMENT_VERIFY via KumoDent routing', async () => {
      const mockWindow = {
        document: mockDocument,
        localStorage: mockStorage,
        location: { origin: 'https://hanadental.aoikumo.com', hostname: 'hanadental.aoikumo.com' },
      } as unknown as Window;

      const res = await executePredefinedAction({
        actionId: ACTION_APPOINTMENT_VERIFY,
        correlationId: 'cmd-kumo-verify-1',
        parameters: {
          appointmentId: 'KUMO-APT-01',
        },
        fetchFn: mockFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(res.status).toBe('SUCCESS');
      const data = res.data as { id: string; patientId: string };
      expect(data.id).toBe('KUMO-APT-01');
      expect(data.patientId).toBe('ZZTEST-KUMO-P01');
    });

    it('executes ACTION_PATIENT_CREATE and ACTION_PATIENT_VERIFY via Secondary Azure API routing', async () => {
      const mockWindow = {
        document: mockDocument,
        localStorage: mockStorage,
        location: { origin: 'https://hanadental.aoikumo.com', hostname: 'hanadental.aoikumo.com' },
      } as unknown as Window;

      // 1. Create Patient
      const createRes = await executePredefinedAction({
        actionId: ACTION_PATIENT_CREATE,
        correlationId: 'cmd-kumo-pat-create-1',
        parameters: {
          fullName: 'Halim bin Othman',
          phone: '+60133445566',
          email: 'halim@example.test',
          icOrPassport: '880101-10-8888',
        },
        fetchFn: mockFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(createRes.status).toBe('SUCCESS');
      const createData = createRes.data as { id: string; fullName: string };
      expect(createData.id).toMatch(/^ZZTEST-KUMO-P/);
      expect(createData.fullName).toBe('Halim bin Othman');

      // 2. Verify Patient (routes to Azure Secondary API with x-aoikumo-access-token)
      const verifyRes = await executePredefinedAction({
        actionId: ACTION_PATIENT_VERIFY,
        correlationId: 'cmd-kumo-pat-verify-1',
        parameters: {
          patientId: createData.id,
        },
        fetchFn: mockFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(verifyRes.status).toBe('SUCCESS');
      const verifyData = verifyRes.data as { id: string; fullName: string; phone: string };
      expect(verifyData.id).toBe(createData.id);
      expect(verifyData.fullName).toBe('Halim bin Othman');
    });

    it('multi-tenant portability: executes actions on arbitrary clinic subdomains (*.aoikumo.com / *.kumodent.com)', async () => {
      const tenantOrigins = [
        'https://klinikdrlee.aoikumo.com',
        'https://smiledental.aoikumo.com',
        'https://premierdental.kumodent.com',
      ];

      for (const origin of tenantOrigins) {
        const tenantHostname = new URL(origin).hostname;
        const tenantWindow = {
          document: mockDocument,
          localStorage: mockStorage,
          location: { origin, hostname: tenantHostname },
        } as unknown as Window;

        const res = await executePredefinedAction({
          actionId: ACTION_APPOINTMENT_CREATE,
          correlationId: `cmd-multitenant-${tenantHostname}`,
          parameters: {
            patientId: 'ZZTEST-KUMO-P-1',
            providerId: 'ZZTEST-DOC-1',
            startTime: '2026-10-12T11:00:00+08:00',
            notes: `Test booking on ${tenantHostname}`,
          },
          fetchFn: mockFetch,
          baseOrigin: origin,
          targetWindow: tenantWindow,
        });

        expect(res.status).toBe('SUCCESS');
        expect(res.data).toBeDefined();
        const data = res.data as { id: string; status: string; providerId: string; patientId: string };
        expect(data.id).toMatch(/^KUMO-APT-/);
        expect(data.status).toBe('booked');
        expect(data.providerId).toBe('ZZTEST-DOC-1');
        expect(data.patientId).toBe('ZZTEST-KUMO-P-1');
      }
    });

    it('executes ACTION_CATALOG_IMPORT extracting sites, doctors with roster, and services', async () => {
      const mockWindow = {
        document: mockDocument,
        localStorage: mockStorage,
        location: { origin: 'https://hanadental.aoikumo.com', hostname: 'hanadental.aoikumo.com' },
      } as unknown as Window;

      const res = await executePredefinedAction({
        actionId: ACTION_CATALOG_IMPORT,
        correlationId: 'cmd-kumo-catalog-1',
        parameters: {},
        fetchFn: mockFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(res.status).toBe('SUCCESS');
      const catalog = res.data as {
        site: { cms_id: string; name: string };
        sites: Array<{ cms_id: string; name: string }>;
        doctors: Array<{ cms_id: string; name: string; roster: Array<{ weekday: number }> }>;
        services: Array<{ cms_id: string; name: string; category: string; price: number; duration_min: number }>;
      };
      expect(catalog.site.cms_id).toBe('1');
      expect(catalog.site.name).toBe('KP HANA SG BULOH');
      expect(Array.isArray(catalog.doctors)).toBe(true);
      expect(catalog.doctors.length).toBeGreaterThan(0);
      expect(catalog.doctors[0].roster.length).toBeGreaterThan(0);
      expect(Array.isArray(catalog.services)).toBe(true);
      expect(catalog.services[0]).toHaveProperty('category');
      expect(catalog.services[0]).toHaveProperty('price');
      expect(catalog.services[0]).toHaveProperty('duration_min');
    });

    it('maps "Room not available" CMS response to SLOT_CONFLICT', async () => {
      const mockWindow = {
        document: mockDocument,
        localStorage: mockStorage,
        location: { origin: 'https://hanadental.aoikumo.com', hostname: 'hanadental.aoikumo.com' },
      } as unknown as Window;

      const res = await executePredefinedAction({
        actionId: ACTION_APPOINTMENT_CREATE,
        correlationId: 'cmd-kumo-create-conflict',
        parameters: {
          patientId: 'ZZTEST-KUMO-P01',
          providerId: 'STAFF-01',
          startTime: '2026-10-06T14:00:00+08:00',
          notes: 'trigger_room_unavailable',
        },
        fetchFn: mockFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(res.status).toBe('CONFLICT');
      expect(res.error?.code).toBe('SLOT_CONFLICT');
    });

    it('passes siteId and time in ACTION_APPOINTMENT_CREATE payload', async () => {
      let interceptedBody: any = null;
      const capturingFetch: typeof fetch = async (input, init) => {
        const urlStr = typeof input === 'string' ? input : (input as Request).url;
        if (urlStr.includes('/appointment/createV2wa_temp')) {
          interceptedBody = JSON.parse(init?.body as string);
        }
        return mockFetch(input, init);
      };

      const mockWindow = {
        document: mockDocument,
        localStorage: mockStorage,
        location: { origin: 'https://hanadental.aoikumo.com', hostname: 'hanadental.aoikumo.com' },
      } as unknown as Window;

      const res = await executePredefinedAction({
        actionId: ACTION_APPOINTMENT_CREATE,
        correlationId: 'cmd-kumo-create-siteid-time',
        parameters: {
          patientId: 'ZZTEST-KUMO-P01',
          providerId: '11',
          siteId: '1',
          time: '09:30',
          startTime: '2026-09-28T09:30:00+08:00',
          notes: 'Deterministic site and time verification',
        },
        fetchFn: capturingFetch,
        baseOrigin: 'https://hanadental.aoikumo.com',
        targetWindow: mockWindow,
      });

      expect(res.status).toBe('SUCCESS');
      expect(interceptedBody).not.toBeNull();
      expect(interceptedBody?.siteId).toBe(1);
      expect(interceptedBody?.siteid).toBe(1);
      expect(interceptedBody?.time).toBe('09:30');
      expect(interceptedBody?.staffId).toBe(11);
    });
  });
});
