// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { MockSyncApiServer } from '../../test-harness/mock-sync-api/server.js';
import { executeRecipe } from '../../src/adapters/interpreter.js';
import { validateAdapterManifest, type AdapterManifest } from '../../src/adapters/schema.js';
import { verifyManifestStrict } from '../../src/adapters/verifier.js';
import {
  syncAndActivateAdapter,
  InMemoryStorageAdapter,
  getActiveManifest,
} from '../../src/adapters/lifecycle.js';

describe('Acme-Cloud Adapter Contract Tests (Phase 6)', () => {
  const CMS_PORT = 4031;
  const baseOrigin = `http://localhost:${CMS_PORT}`;
  const cmsServer = new MockCmsServer(CMS_PORT);
  const manifestPath = path.resolve('src/adapters/manifests/acme-cloud.json');
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  let manifest: AdapterManifest;

  beforeAll(async () => {
    await cmsServer.start();
    // Validate signature and schema of packaged concrete manifest
    await verifyManifestStrict(manifestJson);
    manifest = validateAdapterManifest(manifestJson);
  });

  afterAll(async () => {
    await cmsServer.stop();
  });

  beforeEach(async () => {
    await fetch(`${baseOrigin}/__admin/reset`, { method: 'POST' });
  });

  describe('Read Recipes against Mock CMS', () => {
    it('executes patients_list recipe and extracts array', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients_list',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const patients = res.data as Array<{ id: string; fullName: string }>;
      expect(patients.length).toBeGreaterThanOrEqual(4);
      expect(patients[0].id).toBe('ZZTEST-P01');
    });

    it('executes patients_get recipe with parameterized ID', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patients_get',
        params: { id: 'ZZTEST-P01' },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      const patient = res.data as { id: string; fullName: string };
      expect(patient.id).toBe('ZZTEST-P01');
      expect(patient.fullName).toBe('ZZTEST Patient 01');
    });

    it('executes appointments_list recipe', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments_list',
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(Array.isArray(res.data)).toBe(true);
      const appointments = res.data as Array<{ id: string }>;
      expect(appointments.length).toBeGreaterThanOrEqual(2);
    });

    it('executes appointments_get recipe with parameterized ID', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointments_get',
        params: { id: 'APT-001' },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      const appt = res.data as { id: string; patientId: string };
      expect(appt.id).toBe('APT-001');
      expect(appt.patientId).toBe('ZZTEST-P01');
    });

    it('executes appointments_availability recipe', async () => {
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
      const slots = res.data as Array<{ startTime: string; available: boolean }>;
      expect(slots.length).toBeGreaterThan(0);
      expect(slots[0]).toHaveProperty('available');
    });

    it('executes reference data read recipes (providers, services, locations)', async () => {
      // 1. Providers
      const provRes = await executeRecipe({
        manifest,
        recipeId: 'reference_providers',
        fetchFn: fetch,
        baseOrigin,
      });
      expect(provRes.status).toBe('SUCCESS');
      expect(Array.isArray(provRes.data)).toBe(true);

      // 2. Services
      const srvRes = await executeRecipe({
        manifest,
        recipeId: 'reference_services',
        fetchFn: fetch,
        baseOrigin,
      });
      expect(srvRes.status).toBe('SUCCESS');
      expect(Array.isArray(srvRes.data)).toBe(true);

      // 3. Locations
      const locRes = await executeRecipe({
        manifest,
        recipeId: 'reference_locations',
        fetchFn: fetch,
        baseOrigin,
      });
      expect(locRes.status).toBe('SUCCESS');
      expect(Array.isArray(locRes.data)).toBe(true);
    });
  });

  describe('Write Recipes with Preconditions & Read-After-Write Verification', () => {
    it('executes patient_create recipe with phone normalization and verification', async () => {
      const res = await executeRecipe({
        manifest,
        recipeId: 'patient_create',
        params: {
          fullName: 'Contract Test Patient',
          phone: '012-999 8877', // should normalize to +60129998877
          icOrPassport: '950101-14-1234',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(res.writeReceipt).toBeDefined();
      expect(res.writeReceipt?.externalId).toMatch(/^ZZTEST-P/);

      // Confirm verified entity
      const verified = res.writeReceipt?.data as { id: string; fullName: string; phone: string };
      expect(verified.fullName).toBe('Contract Test Patient');
      expect(verified.phone).toBe('+60129998877');
    });

    it('executes appointment_create recipe with slot availability precondition and verification', async () => {
      // 1. First booking succeeds
      const res = await executeRecipe({
        manifest,
        recipeId: 'appointment_create',
        params: {
          patientId: 'ZZTEST-P01',
          providerId: 'DOC-01',
          serviceId: 'SRV-01',
          locationId: 'LOC-01',
          startTime: '2026-10-01T14:30:00+08:00',
          endTime: '2026-10-01T14:45:00+08:00',
          notes: 'Contract booking',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(res.status).toBe('SUCCESS');
      expect(res.writeReceipt).toBeDefined();
      expect(res.writeReceipt?.externalId).toMatch(/^APT-/);
      expect(res.writeReceipt?.revision).toBe(1);

      const createdId = res.writeReceipt!.externalId;

      // 2. Booking same slot again fails closed with CONFLICT before write
      const clashRes = await executeRecipe({
        manifest,
        recipeId: 'appointment_create',
        params: {
          patientId: 'ZZTEST-P02',
          providerId: 'DOC-01',
          startTime: '2026-10-01T14:30:00+08:00',
          endTime: '2026-10-01T14:45:00+08:00',
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(clashRes.status).toBe('CONFLICT');
      expect(clashRes.error?.code).toBe('CONFLICT');

      // 3. Reschedule the created appointment
      const rescheduleRes = await executeRecipe({
        manifest,
        recipeId: 'appointment_reschedule',
        params: {
          id: createdId,
          startTime: '2026-10-01T15:30:00+08:00',
          endTime: '2026-10-01T15:45:00+08:00',
          expectedRev: 1,
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(rescheduleRes.status).toBe('SUCCESS');
      expect(rescheduleRes.writeReceipt?.externalId).toBe(createdId);
      expect(rescheduleRes.writeReceipt?.revision).toBe(2);

      // 4. Cancel the appointment
      const cancelRes = await executeRecipe({
        manifest,
        recipeId: 'appointment_cancel',
        params: {
          id: createdId,
        },
        fetchFn: fetch,
        baseOrigin,
      });

      expect(cancelRes.status).toBe('SUCCESS');
      expect(cancelRes.writeReceipt?.externalId).toBe(createdId);
      expect(cancelRes.writeReceipt?.revision).toBe(3);

      const cancelledEntity = cancelRes.writeReceipt?.data as { status: string };
      expect(cancelledEntity.status).toBe('cancelled');
    });
  });

  describe('Lifecycle Distribution Contract with MockSyncApiServer', () => {
    const SYNC_PORT = 4032;
    const syncApiServer = new MockSyncApiServer(SYNC_PORT);
    const syncApiUrl = `http://localhost:${SYNC_PORT}`;
    const storage = new InMemoryStorageAdapter();

    beforeAll(async () => {
      await syncApiServer.start();
    });

    afterAll(async () => {
      await syncApiServer.stop();
    });

    it('downloads, verifies signature, stages, probes CMS, and activates candidate against running mock servers', async () => {
      const result = await syncAndActivateAdapter('conn_contract_mock', baseOrigin, {
        syncApiUrl,
        storage,
        probeEndpoint: '/api/reference/providers',
        fetchFn: fetch,
      });

      expect(result.isRollback).toBe(false);
      expect(result.manifest.adapterId).toBe('acme-cloud-v1');

      // Verify active manifest persisted in storage
      const active = await getActiveManifest('acme-cloud-v1', { storage });
      expect(active).not.toBeNull();
      expect(active?.adapterId).toBe('acme-cloud-v1');
    });

    it('gracefully falls back to LKG when Sync API returns tampered manifest variant', async () => {
      const fallbackResult = await syncAndActivateAdapter('conn_contract_mock', baseOrigin, {
        syncApiUrl,
        variant: 'tampered',
        storage,
        probeEndpoint: '/api/reference/providers',
        fetchFn: fetch,
      });

      expect(fallbackResult.isRollback).toBe(true);
      expect(fallbackResult.manifest.adapterId).toBe('acme-cloud-v1');
    });
  });
});
