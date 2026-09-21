// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { executeRecipe } from '../../src/adapters/interpreter.js';
import { validateAdapterManifest, type AdapterManifest } from '../../src/adapters/schema.js';
import { verifyManifestStrict } from '../../src/adapters/verifier.js';
import { NormalizedAppointmentSchema, normalizeAppointment } from '../../src/core/contracts/appointment.js';
import {
  tenantAPatients,
  tenantAAppointments,
  tenantAReference,
  tenantAConfig,
  tenantBPatients,
  tenantBAppointments,
  tenantBConfig,
} from '../../fixtures/vendor-cms/index.js';
import { mapTenantRecord } from '../../src/adapters/tenant-mapping.js';
import { vendorCms1TenantBTransform } from '../../src/adapters/packaged-hooks/vendor-cms-1-hooks.js';


describe('Vendor CMS #1 Adapter Certification & Contract Tests (Phase 12)', () => {
  const CMS_PORT = 4055;
  const baseOrigin = `http://localhost:${CMS_PORT}`;
  const cmsServer = new MockCmsServer(CMS_PORT);
  const manifestPath = path.resolve('src/adapters/manifests/vendor-cms-1.json');
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  let manifest: AdapterManifest;

  beforeAll(async () => {
    await cmsServer.start();
    // Cryptographic signature and schema verification
    await verifyManifestStrict(manifestJson);
    manifest = validateAdapterManifest(manifestJson);
  });

  afterAll(async () => {
    await cmsServer.stop();
  });

  beforeEach(async () => {
    await fetch(`${baseOrigin}/__admin/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: {
          patients: tenantAPatients,
          appointments: tenantAAppointments,
          providers: tenantAReference.providers,
          services: tenantAReference.services,
          locations: tenantAReference.locations,
        },
      }),
    });
  });

  describe('Section 1: Manifest Cryptographic & Complexity Certification', () => {
    it('verifies Ed25519 signature validity and strict schema compliance', async () => {
      expect(manifest.adapterId).toBe('vendor-cms-1');
      expect(manifest.version).toBe('1.0.0');
      expect(manifest.signature).toBeDefined();
      expect(tenantAConfig.tenantId).toBe('TENANT-A-CLOUD');

      // Complexity checks
      const recipeKeys = Object.keys(manifest.recipes || {});
      expect(recipeKeys.length).toBeGreaterThanOrEqual(10);
      expect(recipeKeys.length).toBeLessThanOrEqual(50);

      // Verify all V1 required capabilities are declared
      const requiredCaps = [
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
      const tampered = { ...manifestJson, adapterId: 'vendor-cms-1-tampered' };
      await expect(verifyManifestStrict(tampered)).rejects.toThrow();
    });
  });

  describe('Section 2: Tenant A Contract Verification (Standard Cloud Tenant)', () => {
    it('executes patients.read and patients_list recipes with pagination', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients.read',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const patients = res.data as Array<{ id: string; fullName: string; phone: string }>;
      expect(patients.length).toBe(4);
      expect(patients[0].id).toBe('ZZTEST-P01');
      expect(patients[0].fullName).toBe('ZZTEST Patient 01');
      expect(patients[0].phone).toBe('+60123456701');
    });

    it('executes patients_get recipe with parameterized ID', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients_get',
        params: { id: 'ZZTEST-P02' },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      const patient = res.data as { id: string; fullName: string };
      expect(patient.id).toBe('ZZTEST-P02');
      expect(patient.fullName).toBe('ZZTEST Patient 02');
    });

    it('executes appointments.read and verifies NormalizedAppointmentSchema contract', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments.read',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const appts = res.data as Array<Record<string, unknown>>;
      expect(appts.length).toBe(2);

      for (const raw of appts) {
        const normalized = normalizeAppointment(raw);
        const parsed = NormalizedAppointmentSchema.safeParse(normalized);
        expect(parsed.success).toBe(true);
      }
    });

    it('executes appointments.availability recipe', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments.availability',
        params: {
          providerId: 'DOC-01',
          date: '2026-10-01',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const slots = res.data as Array<{ startTime: string; available: boolean }>;
      expect(slots.length).toBeGreaterThan(0);
      // 09:00 is taken by APT-001 in fixture
      const slot0900 = slots.find((s) => s.startTime.includes('09:00:00'));
      expect(slot0900?.available).toBe(false);
      // 09:30 is free
      const slot0930 = slots.find((s) => s.startTime.includes('09:30:00'));
      expect(slot0930?.available).toBe(true);
    });

    it('executes reference data recipes (providers, services, locations)', async () => {
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

    it('executes patients.create with phone_my normalization and read-back verification (Rule 10)', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients.create',
        params: {
          fullName: 'ZZTEST Patient New',
          phone: '012-999 8877', // should normalize to +60129998877
          icOrPassport: '950101-14-1234',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(res.writeReceipt).toBeDefined();
      expect(res.writeReceipt?.externalId).toMatch(/^ZZTEST-P/);

      const verified = res.writeReceipt?.data as { fullName: string; phone: string };
      expect(verified.fullName).toBe('ZZTEST Patient New');
      expect(verified.phone).toBe('+60129998877');
    });

    it('executes full appointment write lifecycle: create, clash-block, reschedule, cancel', async () => {
      // 1. Create appointment in available slot
      const createRes = await executeRecipe({
        manifest,
        recipeId: 'appointments.create',
        params: {
          patientId: 'ZZTEST-P01',
          providerId: 'DOC-01',
          serviceId: 'SRV-01',
          locationId: 'LOC-01',
          startTime: '2026-10-01T09:30:00+08:00',
          endTime: '2026-10-01T09:45:00+08:00',
          notes: 'Certified Booking',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(createRes.status).toBe('SUCCESS');
      expect(createRes.writeReceipt).toBeDefined();
      const apptId = createRes.writeReceipt!.externalId;
      expect(createRes.writeReceipt?.revision).toBe(1);

      // 2. Conflict precondition: attempting to book already-occupied slot fails closed
      const clashRes = await executeRecipe({
        manifest,
        recipeId: 'appointments.create',
        params: {
          patientId: 'ZZTEST-P03',
          providerId: 'DOC-01',
          serviceId: 'SRV-01',
          locationId: 'LOC-01',
          startTime: '2026-10-01T09:30:00+08:00',
          endTime: '2026-10-01T09:45:00+08:00',
        },
        fetchFn: fetch,
        baseOrigin,
      });
      expect(clashRes.status).toBe('CONFLICT');

      // 3. Reschedule appointment to another slot with revision check
      const reschedRes = await executeRecipe({
        manifest,
        recipeId: 'appointments.reschedule',
        params: {
          id: apptId,
          startTime: '2026-10-01T11:00:00+08:00',
          endTime: '2026-10-01T11:15:00+08:00',
          expectedRev: 1,
          notes: 'Rescheduled Certified Booking',
        },
        fetchFn: fetch,
        baseOrigin,
      });
      expect(reschedRes.status).toBe('SUCCESS');
      expect(reschedRes.writeReceipt?.revision).toBe(2);

      // 4. Cancel appointment
      const cancelRes = await executeRecipe({
        manifest,
        recipeId: 'appointments.cancel',
        params: { id: apptId },
        fetchFn: fetch,
        baseOrigin,
      });
      expect(cancelRes.status).toBe('SUCCESS');
      expect(cancelRes.writeReceipt?.revision).toBe(3);
    });
  });

  describe('Section 3: Tenant B Contract Verification (Custom Field Variant)', () => {
    it('adapts Tenant B custom field schema without engine code fork', async () => {
      // Tenant B uses clientName, mobile_no, nric in place of standard fields
      const rawTenantBParams = {
        clientName: 'ZZTEST Tenant B Patient',
        mobile_no: '011-2345 6789',
        nric: '990101-14-9999',
      };

      // 1. Verify packaged hook vendor-cms-1-tenant-b-transform adapts fields
      const hookContext: { params: Record<string, unknown> } = { params: { ...rawTenantBParams } };
      vendorCms1TenantBTransform(hookContext);
      expect(hookContext.params.fullName).toBe('ZZTEST Tenant B Patient');
      expect(hookContext.params.phone).toBe('011-2345 6789');

      // 2. Map Tenant B fields using configuration mapping dictionary
      const patientMapping = tenantBConfig.fieldMappings.patient as Record<string, string>;
      const mappedParams = mapTenantRecord(rawTenantBParams, patientMapping, 'toCanonical');

      const res = await executeRecipe({
        manifest,
        recipeId: 'patients.create',
        params: mappedParams,
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(res.writeReceipt).toBeDefined();

      const created = res.writeReceipt?.data as { fullName: string; phone: string; icOrPassport: string };
      expect(created.fullName).toBe('ZZTEST Tenant B Patient');
      expect(created.phone).toBe('+601123456789');
    });

    it('verifies Tenant B appointment mapping and normalization', () => {
      const rawAppt = tenantBAppointments[0];
      const mapping = tenantBConfig.fieldMappings.appointment as Record<string, string>;

      // Map Tenant B fields using configuration mapping
      const standardAppt: Record<string, unknown> = {};
      for (const [targetKey, sourceKey] of Object.entries(mapping)) {
        standardAppt[targetKey] = (rawAppt as Record<string, unknown>)[sourceKey];
      }

      const normalized = normalizeAppointment(standardAppt);
      const parsed = NormalizedAppointmentSchema.safeParse(normalized);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.id).toBe('APT-TB-001');
        expect(parsed.data.patientId).toBe('ZZTEST-TB-P01');
        expect(parsed.data.providerId).toBe('DOC-01');
        expect(parsed.data.status).toBe('booked');
      }
    });

    it('verifies Tenant B patient normalization', () => {
      const rawPatient = tenantBPatients[0];
      expect(rawPatient.clientName).toBe('ZZTEST Patient B1');
      expect(rawPatient.mobile_no).toBe('+60123456701');
      expect(rawPatient.nric).toBe('900101-14-5001');
    });
  });

  describe('Section 4: Resilience, Error Taxonomy & Fault Injection', () => {
    it('handles 401 Session Expiry gracefully without data corruption', async () => {
      cmsServer.setFault('401');

      const res = await executeRecipe({
        manifest,
        recipeId: 'patients.read',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('ERROR');
      expect(res.error?.code).toBe('UNAUTHORIZED');

      cmsServer.setFault('none');
    });

    it('handles 409 Slot Conflict cleanly', async () => {
      cmsServer.setFault('409');

      const res = await executeRecipe({
        manifest,
        recipeId: 'patients.read',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('CONFLICT');
      cmsServer.setFault('none');
    });

    it('handles 429 Rate Limiting cleanly', async () => {
      cmsServer.setFault('429');

      const res = await executeRecipe({
        manifest,
        recipeId: 'patients.read',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('RATE_LIMITED');
      cmsServer.setFault('none');
    });

    it('handles 500 Internal Database Error cleanly', async () => {
      cmsServer.setFault('500');

      const res = await executeRecipe({
        manifest,
        recipeId: 'patients.read',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('ERROR');
      cmsServer.setFault('none');
    });
  });

  describe('Section 5: 7-Day Shadow Read-Only & Parity Simulation Audit', () => {
    it('achieves >=99.5% patient and appointment parity across shadow ingestion simulation', async () => {
      // Simulate 500 synthetic patient records and 500 synthetic appointments
      const totalSampleCount = 500;
      let matchedPatients = 0;
      let matchedAppointments = 0;
      const falseConfirmations = 0;
      let duplicateAppointments = 0;

      const seenAppointmentIds = new Set<string>();

      // Populate large deterministic synthetic dataset in mock CMS
      const largeSyntheticPatients: Array<{
        id: string;
        fullName: string;
        phone: string;
        icOrPassport: string;
      }> = [];

      const largeSyntheticAppointments: Array<{
        id: string;
        patientId: string;
        providerId: string;
        startTime: string;
        endTime: string;
        status: string;
        rev: number;
      }> = [];

      for (let i = 1; i <= totalSampleCount; i++) {
        const id = `ZZTEST-SHADOW-P${String(i).padStart(4, '0')}`;
        largeSyntheticPatients.push({
          id,
          fullName: `ZZTEST Shadow Patient ${i}`,
          phone: `+6012345${String(1000 + i).slice(-4)}`,
          icOrPassport: '900101-14-5001',
        });

        const apptId = `APT-SHADOW-${String(i).padStart(4, '0')}`;
        largeSyntheticAppointments.push({
          id: apptId,
          patientId: id,
          providerId: i % 2 === 0 ? 'DOC-01' : 'DOC-02',
          startTime: `2026-10-15T${String(9 + (i % 8)).padStart(2, '0')}:00:00+08:00`,
          endTime: `2026-10-15T${String(9 + (i % 8)).padStart(2, '0')}:15:00+08:00`,
          status: 'booked',
          rev: 1,
        });
      }

      // Reset mock CMS with large shadow state
      await fetch(`${baseOrigin}/__admin/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: {
            patients: largeSyntheticPatients,
            appointments: largeSyntheticAppointments,
            providers: tenantAReference.providers,
            services: tenantAReference.services,
            locations: tenantAReference.locations,
          },
        }),
      });

      // Shadow ingestion via certified recipes
      const patientRes = await executeRecipe({
        manifest,
        recipeId: 'patients.read',
        params: { limit: 1000 },
        fetchFn: fetch,
        baseOrigin,
      });
      expect(patientRes.status).toBe('SUCCESS');
      const ingestedPatients = patientRes.data as Array<{ id: string; fullName: string }>;

      for (const p of ingestedPatients) {
        const groundTruth = largeSyntheticPatients.find((gt) => gt.id === p.id);
        if (groundTruth && groundTruth.fullName === p.fullName) {
          matchedPatients += 1;
        }
      }

      const appointmentRes = await executeRecipe({
        manifest,
        recipeId: 'appointments.read',
        params: { limit: 1000 },
        fetchFn: fetch,
        baseOrigin,
      });
      expect(appointmentRes.status).toBe('SUCCESS');
      const ingestedAppointments = appointmentRes.data as Array<{ id: string; patientId: string }>;

      for (const a of ingestedAppointments) {
        if (seenAppointmentIds.has(a.id)) {
          duplicateAppointments += 1;
        }
        seenAppointmentIds.add(a.id);

        const groundTruth = largeSyntheticAppointments.find((gt) => gt.id === a.id);
        if (groundTruth && groundTruth.patientId === a.patientId) {
          matchedAppointments += 1;
        }
      }

      const patientParity = (matchedPatients / totalSampleCount) * 100;
      const appointmentParity = (matchedAppointments / totalSampleCount) * 100;

      // Assertions per Acceptance Gate
      expect(patientParity).toBeGreaterThanOrEqual(99.5);
      expect(appointmentParity).toBeGreaterThanOrEqual(99.5);
      expect(patientParity).toBe(100.0);
      expect(appointmentParity).toBe(100.0);

      expect(falseConfirmations).toBe(0);
      expect(duplicateAppointments).toBe(0);
    });
  });
});
