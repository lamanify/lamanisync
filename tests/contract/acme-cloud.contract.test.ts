// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { executeRecipe } from '../../src/adapters/interpreter.js';
import { validateAdapterManifest, type AdapterManifest } from '../../src/adapters/schema.js';
import { verifyManifestStrict } from '../../src/adapters/verifier.js';
import { NormalizedAppointmentSchema, normalizeAppointment } from '../../src/core/contracts/appointment.js';

describe('Acme-Cloud Adapter Capability Contract Tests (Phase 11)', () => {
  const CMS_PORT = 4033;
  const baseOrigin = `http://localhost:${CMS_PORT}`;
  const cmsServer = new MockCmsServer(CMS_PORT);
  const manifestPath = path.resolve('src/adapters/manifests/acme-cloud.json');
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  let manifest: AdapterManifest;

  beforeAll(async () => {
    await cmsServer.start();
    await verifyManifestStrict(manifestJson);
    manifest = validateAdapterManifest(manifestJson);
  });

  afterAll(async () => {
    await cmsServer.stop();
  });

  beforeEach(async () => {
    await fetch(`${baseOrigin}/__admin/reset`, { method: 'POST' });
  });

  describe('Contract Verification: Read Capabilities', () => {
    it('verifies patients_list contract against synthetic fixtures', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients_list',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const patients = res.data as Array<{ id: string; fullName: string; icOrPassport?: string }>;
      expect(patients.length).toBeGreaterThanOrEqual(4);
      expect(patients[0].id).toBe('ZZTEST-P01');
      expect(patients[0].fullName).toBe('ZZTEST Patient 01');
    });

    it('verifies patients_get contract against synthetic fixtures', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients_get',
        params: { id: 'ZZTEST-P02' },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      const patient = res.data as { id: string; fullName: string; phone: string };
      expect(patient.id).toBe('ZZTEST-P02');
      expect(patient.fullName).toBe('ZZTEST Patient 02');
      expect(patient.phone).toBe('+60123456702');
    });

    it('verifies appointments_list contract matches NormalizedAppointmentSchema', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments_list',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const appts = res.data as Array<Record<string, unknown>>;
      expect(appts.length).toBeGreaterThanOrEqual(2);

      // Verify each appointment satisfies core NormalizedAppointmentSchema contract
      for (const item of appts) {
        const normalized = normalizeAppointment(item);
        const parsed = NormalizedAppointmentSchema.safeParse(normalized);
        expect(parsed.success).toBe(true);
      }
    });

    it('verifies appointments_get contract returns single verified appointment', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments_get',
        params: { id: 'APT-001' },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      const normalized = normalizeAppointment(res.data);
      const parsed = NormalizedAppointmentSchema.safeParse(normalized);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.id).toBe('APT-001');
        expect(parsed.data.patientId).toBe('ZZTEST-P01');
      }
    });

    it('verifies appointments_availability contract slot structure', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments_availability',
        params: {
          providerId: 'DOC-01',
          date: '2026-10-01',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const slots = res.data as Array<{ startTime: string; endTime: string; available: boolean }>;
      expect(slots.length).toBeGreaterThan(0);
      expect(typeof slots[0].startTime).toBe('string');
      expect(typeof slots[0].available).toBe('boolean');
    });

    it('verifies reference data contracts (providers, services, locations)', async () => {
      const [prov, srv, loc] = await Promise.all([
        executeRecipe({ manifest, recipeId: 'reference_providers', fetchFn: fetch, baseOrigin }),
        executeRecipe({ manifest, recipeId: 'reference_services', fetchFn: fetch, baseOrigin }),
        executeRecipe({ manifest, recipeId: 'reference_locations', fetchFn: fetch, baseOrigin }),
      ]);

      expect(prov.status).toBe('SUCCESS');
      expect(srv.status).toBe('SUCCESS');
      expect(loc.status).toBe('SUCCESS');

      expect(Array.isArray(prov.data)).toBe(true);
      expect(Array.isArray(srv.data)).toBe(true);
      expect(Array.isArray(loc.data)).toBe(true);
    });
  });

  describe('Contract Verification: Write Capabilities & Read-After-Write', () => {
    it('verifies patient_create capability contract with phone normalization', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patient_create',
        params: {
          fullName: 'Contract Patient New',
          phone: '011-2345 6789',
          icOrPassport: '990101-14-9999',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(res.writeReceipt).toBeDefined();
      expect(res.writeReceipt?.externalId).toMatch(/^ZZTEST-P/);

      const verified = res.writeReceipt?.data as { id: string; fullName: string; phone: string };
      expect(verified.fullName).toBe('Contract Patient New');
      expect(verified.phone).toBe('+601123456789');
    });

    it('verifies appointment lifecycle contract: create, conflict-block, reschedule, cancel', async () => {
      // Create
      const createRes = await executeRecipe({
        manifest,
        recipeId: 'appointment_create',
        params: {
          patientId: 'ZZTEST-P01',
          providerId: 'DOC-01',
          serviceId: 'SRV-01',
          locationId: 'LOC-01',
          startTime: '2026-10-02T10:00:00+08:00',
          endTime: '2026-10-02T10:15:00+08:00',
          notes: 'Contract Suite Booking',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(createRes.status).toBe('SUCCESS');
      expect(createRes.writeReceipt).toBeDefined();
      const apptId = createRes.writeReceipt!.externalId;
      expect(createRes.writeReceipt?.revision).toBe(1);

      // Conflict precondition check: booking same slot fails closed
      const clashRes = await executeRecipe({
        manifest,
        recipeId: 'appointment_create',
        params: {
          patientId: 'ZZTEST-P03',
          providerId: 'DOC-01',
          startTime: '2026-10-02T10:00:00+08:00',
          endTime: '2026-10-02T10:15:00+08:00',
        },
        fetchFn: fetch,
        baseOrigin,
      });
      expect(clashRes.status).toBe('CONFLICT');

      // Reschedule
      const reschedRes = await executeRecipe({
        manifest,
        recipeId: 'appointment_reschedule',
        params: {
          id: apptId,
          startTime: '2026-10-02T11:00:00+08:00',
          endTime: '2026-10-02T11:15:00+08:00',
          expectedRev: 1,
        },
        fetchFn: fetch,
        baseOrigin,
      });
      expect(reschedRes.status).toBe('SUCCESS');
      expect(reschedRes.writeReceipt?.revision).toBe(2);

      // Cancel
      const cancelRes = await executeRecipe({
        manifest,
        recipeId: 'appointment_cancel',
        params: { id: apptId },
        fetchFn: fetch,
        baseOrigin,
      });
      expect(cancelRes.status).toBe('SUCCESS');
      expect(cancelRes.writeReceipt?.revision).toBe(3);
    });
  });
});
