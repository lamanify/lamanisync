// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { executeRecipe } from '../../src/adapters/interpreter.js';
import { validateAdapterManifest, type AdapterManifest } from '../../src/adapters/schema.js';
import { verifyManifestStrict } from '../../src/adapters/verifier.js';
import {
  executePredefinedAction,
  ACTION_APPOINTMENT_CREATE,
} from '../../src/page/action-runner.js';
import { verifyReadBackRecord } from '../../src/core/verification.js';
import { CommandExecutor } from '../../src/background/command-executor.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import type { SyncApiClient } from '../../src/background/api-client.js';
import type { LeaseCoordinator } from '../../src/background/lease-client.js';
import type { SyncCommand } from '../../src/core/contracts/commands.js';

describe('LamaniPulse Adapter Capability Contract Tests', () => {
  const manifestPath = path.resolve('src/adapters/manifests/lamanipulse.json');
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  let manifest: AdapterManifest;

  beforeAll(async () => {
    // 1. Verify cryptographic signature and schema validity
    await verifyManifestStrict(manifestJson);
    manifest = validateAdapterManifest(manifestJson);
  });

  describe('Section 1: Manifest Schema & Cryptographic Signature', () => {
    it('verifies Ed25519 signature and required capabilities', () => {
      expect(manifest.adapterId).toBe('lamanipulse-v1');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.targetOrigin).toBe('https://app.lamanipulse.com');
      expect(manifest.signature).toBeDefined();

      const requiredCaps = [
        'PATIENT_READ',
        'PATIENT_WRITE',
        'APPOINTMENT_READ',
        'APPOINTMENT_WRITE',
        'REFERENCE_DATA_READ',
        'patients.read',
        'patients.create',
        'patients.update',
        'appointments.read',
        'appointments.create',
        'appointments.reschedule',
        'appointments.cancel',
        'reference.read',
      ];
      for (const cap of requiredCaps) {
        expect(manifest.capabilities).toContain(cap);
      }
    });

    it('declares exact PostgREST endpoints for all resource domains', () => {
      expect(manifest.endpoints?.patients?.list).toBe('/rest/v1/patients');
      expect(manifest.endpoints?.appointments?.list).toBe('/rest/v1/appointments');
      expect(manifest.endpoints?.reference?.providers).toBe('/rest/v1/profiles');
      expect(manifest.endpoints?.reference?.services).toBe('/rest/v1/medical_services');
      expect(manifest.endpoints?.reference?.locations).toBe('/rest/v1/clinic_settings');
    });
  });

  describe('Section 2: PostgREST Read Recipes Simulation', () => {
    // Mock PostgREST backend database state
    const mockDb = {
      patients: [
        { id: 'PAT-PULSE-01', full_name: 'Ahmad bin Ali', phone: '+60123456701', ic_or_passport: '900101-14-5001' },
        { id: 'PAT-PULSE-02', full_name: 'Fatimah binti Hassan', phone: '+60123456702', ic_or_passport: '920202-10-5002' },
      ],
      appointments: [
        {
          id: 'APT-PULSE-01',
          patient_id: 'PAT-PULSE-01',
          provider_id: 'DOC-01',
          start_time: '2026-10-01T09:00:00+08:00',
          end_time: '2026-10-01T09:30:00+08:00',
          status: 'booked',
          rev: 1,
        },
      ],
      profiles: [
        { id: 'DOC-01', full_name: 'Dr. Sarah Ahmad', role: 'Doctor' },
      ],
      services: [
        { id: 'SRV-01', name: 'General Consultation', duration_minutes: 15 },
      ],
      locations: [
        { id: 'LOC-01', name: 'Main Clinic Bangsar' },
      ],
    };

    const mockPostgrestFetch: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : (input as Request).url;
      const parsed = new URL(urlStr, 'https://app.lamanipulse.com');
      const pathname = parsed.pathname;
      const method = (init?.method || 'GET').toUpperCase();

      if (pathname === '/rest/v1/patients') {
        if (method === 'GET') {
          const idFilter = parsed.searchParams.get('id');
          if (idFilter && idFilter.startsWith('eq.')) {
            const targetId = idFilter.replace('eq.', '');
            const found = mockDb.patients.filter((p) => p.id === targetId);
            return new Response(JSON.stringify(found), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify(mockDb.patients), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'POST') {
          const body = JSON.parse(init?.body as string);
          const newPatient = {
            id: `PAT-PULSE-${Date.now()}`,
            full_name: body.fullName || body.full_name,
            phone: body.phone,
            ic_or_passport: body.icOrPassport || body.ic_or_passport,
          };
          mockDb.patients.push(newPatient);
          return new Response(JSON.stringify([newPatient]), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (pathname === '/rest/v1/appointments') {
        if (method === 'GET') {
          const idFilter = parsed.searchParams.get('id');
          if (idFilter && idFilter.startsWith('eq.')) {
            const targetId = idFilter.replace('eq.', '');
            const found = mockDb.appointments.filter((a) => a.id === targetId);
            return new Response(JSON.stringify(found), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify(mockDb.appointments), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'POST') {
          const body = JSON.parse(init?.body as string);
          const newAppt = {
            id: `APT-PULSE-${Date.now()}`,
            patient_id: body.patientId || body.patient_id,
            provider_id: body.providerId || body.provider_id,
            start_time: body.startTime || body.start_time,
            end_time: body.endTime || body.end_time,
            status: 'booked',
            rev: 1,
          };
          mockDb.appointments.push(newAppt);
          return new Response(JSON.stringify([newAppt]), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'PUT') {
          const idFilter = parsed.searchParams.get('id');
          const targetId = idFilter ? idFilter.replace('eq.', '') : '';
          const existing = mockDb.appointments.find((a) => a.id === targetId);
          if (!existing) {
            return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
          }
          const body = JSON.parse(init?.body as string);
          if (body.startTime) existing.start_time = body.startTime;
          if (body.endTime) existing.end_time = body.endTime;
          if (body.status) existing.status = body.status;
          existing.rev += 1;
          return new Response(JSON.stringify([existing]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (pathname === '/rest/v1/profiles') {
        return new Response(JSON.stringify(mockDb.profiles), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (pathname === '/rest/v1/medical_services') {
        return new Response(JSON.stringify(mockDb.services), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (pathname === '/rest/v1/clinic_settings') {
        return new Response(JSON.stringify(mockDb.locations), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
    };

    it('executes patients_list and patients.read recipes against PostgREST schema', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients_list',
        fetchFn: mockPostgrestFetch,
        baseOrigin: 'https://app.lamanipulse.com',
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const list = res.data as Array<{ id: string; full_name: string }>;
      expect(list.length).toBe(2);
      expect(list[0].id).toBe('PAT-PULSE-01');
      expect(list[0].full_name).toBe('Ahmad bin Ali');
    });

    it('executes patients_get recipe with parameterized ID filter', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients_get',
        params: { id: 'PAT-PULSE-02' },
        fetchFn: mockPostgrestFetch,
        baseOrigin: 'https://app.lamanipulse.com',
      });

      expect(res.status).toBe('SUCCESS');
      const records = res.data as Array<{ id: string; full_name: string }>;
      expect(records.length).toBe(1);
      expect(records[0].id).toBe('PAT-PULSE-02');
      expect(records[0].full_name).toBe('Fatimah binti Hassan');
    });

    it('executes reference data recipes (profiles, medical_services, clinic_settings)', async () => {
      const [profiles, services, locations] = await Promise.all([
        executeRecipe({ manifest, recipeId: 'reference_providers', fetchFn: mockPostgrestFetch, baseOrigin: 'https://app.lamanipulse.com' }),
        executeRecipe({ manifest, recipeId: 'reference_services', fetchFn: mockPostgrestFetch, baseOrigin: 'https://app.lamanipulse.com' }),
        executeRecipe({ manifest, recipeId: 'reference_locations', fetchFn: mockPostgrestFetch, baseOrigin: 'https://app.lamanipulse.com' }),
      ]);

      expect(profiles.status).toBe('SUCCESS');
      expect(services.status).toBe('SUCCESS');
      expect(locations.status).toBe('SUCCESS');
      expect(Array.isArray(profiles.data)).toBe(true);
      expect(Array.isArray(services.data)).toBe(true);
      expect(Array.isArray(locations.data)).toBe(true);
    });
  });

  describe('Section 3: Write Lifecycle and Read-After-Write Verification', () => {
    it('verifies read-back of appointment created in PostgREST with snake_case fields', () => {
      const intended = {
        patientId: 'PAT-PULSE-01',
        providerId: 'DOC-01',
        startTime: '2026-10-02T10:00:00+08:00',
        endTime: '2026-10-02T10:15:00+08:00',
      };

      // PostgREST read-back returns array of snake_case objects
      const postgrestResponse = [
        {
          id: 'APT-PULSE-999',
          patient_id: 'PAT-PULSE-01',
          provider_id: 'DOC-01',
          start_time: '2026-10-02T02:00:00Z',
          end_time: '2026-10-02T02:15:00Z',
          status: 'booked',
          rev: 1,
        },
      ];

      const diff = verifyReadBackRecord('CREATE_APPOINTMENT', intended, postgrestResponse);
      expect(diff.verified).toBe(true);
      expect(diff.writeReceipt?.externalId).toBe('APT-PULSE-999');
      expect(diff.writeReceipt?.revision).toBe(1);
    });

    it('delegates action to window.supabase in MAIN world context', async () => {
      const mockSupabase = {
        from: (table: string) => {
          expect(table).toBe('appointments');
          return {
            insert: (values: Record<string, unknown>) => {
              expect(values.patient_id).toBe('PAT-PULSE-01');
              return {
                select: () => ({
                  single: async () => ({
                    data: {
                      id: 'APT-PULSE-SB-1',
                      patient_id: values.patient_id,
                      provider_id: values.provider_id,
                      start_time: values.start_time,
                      end_time: values.end_time,
                      status: 'booked',
                      rev: 1,
                      created_at: '2026-09-23T00:00:00Z',
                    },
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      };

      const result = await executePredefinedAction({
        actionId: ACTION_APPOINTMENT_CREATE,
        correlationId: 'test-sb-cor-1',
        parameters: {
          patientId: 'PAT-PULSE-01',
          providerId: 'DOC-01',
          startTime: '2026-10-02T14:00:00+08:00',
          endTime: '2026-10-02T14:15:00+08:00',
        },
        supabaseClient: mockSupabase,
      });

      expect(result.status).toBe('SUCCESS');
      const apptData = result.data as { id: string; patientId: string };
      expect(apptData.id).toBe('APT-PULSE-SB-1');
      expect(apptData.patientId).toBe('PAT-PULSE-01');
    });

    it('verifies read-back of rescheduled appointment with snake_case response', () => {
      const intended = {
        appointmentId: 'APT-PULSE-01',
        startTime: '2026-10-02T11:00:00+08:00',
        endTime: '2026-10-02T11:30:00+08:00',
      };

      const postgrestResponse = [
        {
          id: 'APT-PULSE-01',
          patient_id: 'PAT-PULSE-01',
          provider_id: 'DOC-01',
          start_time: '2026-10-02T03:00:00Z',
          end_time: '2026-10-02T03:30:00Z',
          status: 'booked',
          rev: 2,
        },
      ];

      const diff = verifyReadBackRecord('RESCHEDULE_APPOINTMENT', intended, postgrestResponse);
      expect(diff.verified).toBe(true);
      expect(diff.writeReceipt?.externalId).toBe('APT-PULSE-01');
      expect(diff.writeReceipt?.revision).toBe(2);
    });

    it('verifies read-back of cancelled appointment with snake_case response', () => {
      const intended = {
        appointmentId: 'APT-PULSE-01',
      };

      const postgrestResponse = [
        {
          id: 'APT-PULSE-01',
          patient_id: 'PAT-PULSE-01',
          status: 'cancelled',
          rev: 3,
        },
      ];

      const diff = verifyReadBackRecord('CANCEL_APPOINTMENT', intended, postgrestResponse);
      expect(diff.verified).toBe(true);
      expect(diff.writeReceipt?.externalId).toBe('APT-PULSE-01');
    });

    it('verifies read-back of patient created in PostgREST with snake_case fields', () => {
      const intended = {
        fullName: 'Zainab binti Mahmud',
        phone: '+60198765432',
      };

      const postgrestResponse = [
        {
          id: 'PAT-PULSE-888',
          full_name: 'Zainab binti Mahmud',
          phone: '+60198765432',
        },
      ];

      const diff = verifyReadBackRecord('CREATE_PATIENT', intended, postgrestResponse);
      expect(diff.verified).toBe(true);
      expect(diff.writeReceipt?.externalId).toBe('PAT-PULSE-888');
    });

    it('CommandExecutor dynamically resolves PostgREST verification endpoint using manifest', async () => {
      let readEndpointCalled = '';
      const customFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        const method = init?.method || 'GET';

        if (url.includes('/rest/v1/appointments') && method === 'GET') {
          readEndpointCalled = url;
          return new Response(
            JSON.stringify([
              {
                id: 'APT-PULSE-777',
                patient_id: 'PAT-01',
                provider_id: 'DOC-01',
                start_time: '2026-10-05T09:00:00+08:00',
                end_time: '2026-10-05T09:30:00+08:00',
                status: 'booked',
                rev: 1,
              },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const mockApiClient = {
        fetchNextCommand: async () => null,
        reportCommandResult: async () => ({ acknowledged: true }),
      } as unknown as SyncApiClient;

      const mockLeaseCoordinator = {
        getActiveLease: () => ({
          connectionId: 'conn-pulse-1',
          leaseId: 'lease-pulse-1',
          fencingToken: 1,
        }),
      } as unknown as LeaseCoordinator;

      const fsm = new ConnectionFSM({ state: 'ACTIVE' });

      const executor = new CommandExecutor({
        apiClient: mockApiClient,
        leaseCoordinator: mockLeaseCoordinator,
        fsm,
        targetOrigin: 'https://app.lamanipulse.com',
        fetchFn: customFetch,
        adapterManifest: manifest,
        actionDispatcher: async () => ({
          status: 'SUCCESS',
          data: { id: 'APT-PULSE-777' },
        }),
      });

      const cmd = {
        commandId: 'cmd-pulse-exec-1',
        action: 'ACTION_APPOINTMENT_CREATE',
        parameters: {
          patientId: 'PAT-01',
          providerId: 'DOC-01',
          startTime: '2026-10-05T09:00:00+08:00',
          endTime: '2026-10-05T09:30:00+08:00',
        },
        connectionId: 'conn-pulse-1',
        createdAt: new Date().toISOString(),
      };

      const result = await executor.executeCommand(cmd as unknown as SyncCommand);
      expect(result.status).toBe('VERIFIED');
      expect(readEndpointCalled).toBe('https://app.lamanipulse.com/rest/v1/appointments?id=eq.APT-PULSE-777');
    });
  });
});
