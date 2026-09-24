// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { MockSyncApiServer } from '../../test-harness/mock-sync-api/server.js';
import { verifyManifestSignature } from '../../test-harness/fixtures/signing-keys.js';

describe('Local Test Harness Mock Servers', () => {
  const cmsServer = new MockCmsServer(4015);
  const syncServer = new MockSyncApiServer(4016, 'http://localhost:4015');

  beforeAll(async () => {
    await Promise.all([cmsServer.start(), syncServer.start()]);
  });

  afterAll(async () => {
    await Promise.all([cmsServer.stop(), syncServer.stop()]);
  });

  beforeEach(async () => {
    await fetch('http://localhost:4015/__admin/reset', { method: 'POST' });
    await fetch('http://localhost:4016/__admin/reset', { method: 'POST' });
  });

  describe('Mock CMS API & Web Portal', () => {
    it('serves an actual HTML staff portal on root path', async () => {
      const res = await fetch('http://localhost:4015/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('ACME Clinic Cloud CMS (Mock Portal)');
      expect(html).toContain('loginBtn');
    });

    it('returns synthetic patient list', async () => {
      const res = await fetch('http://localhost:4015/api/patients');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(4);
      expect(body.data[0].id).toBe('ZZTEST-P01');
      expect(body.data[0].fullName).toBe('ZZTEST Patient 01');
    });

    it('returns single patient by ID and 404 for unknown', async () => {
      const res = await fetch('http://localhost:4015/api/patients/ZZTEST-P01');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.fullName).toBe('ZZTEST Patient 01');

      const notFound = await fetch('http://localhost:4015/api/patients/UNKNOWN');
      expect(notFound.status).toBe(404);
    });

    it('creates new synthetic patient', async () => {
      const res = await fetch('http://localhost:4015/api/patients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: 'ZZTEST Patient 05',
          phone: '+60123456705',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe('ZZTEST-P05');
      expect(body.data.fullName).toBe('ZZTEST Patient 05');
    });

    it('verifies literal route wins: availability vs appointment id', async () => {
      // 1. Literal route /api/appointments/availability
      const availRes = await fetch('http://localhost:4015/api/appointments/availability?providerId=DOC-01&date=2026-10-01');
      expect(availRes.status).toBe(200);
      const avail = await availRes.json();
      expect(avail.slots).toBeDefined();
      expect(Array.isArray(avail.slots)).toBe(true);

      // 2. Resource route /api/appointments/:id
      const apptRes = await fetch('http://localhost:4015/api/appointments/APT-001');
      expect(apptRes.status).toBe(200);
      const appt = await apptRes.json();
      expect(appt.data.id).toBe('APT-001');
      // Confirms non-UTC Malaysian local date fields exist
      expect(appt.data.slotDate).toBe('2026-10-01');
      expect(appt.data.slotTimeNaive).toBe('09:00:00');
      expect(appt.data.displayTime).toBe('01/10/2026 09:00 AM');
    });

    it('creates, reschedules, and cancels appointments', async () => {
      const createRes = await fetch('http://localhost:4015/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId: 'ZZTEST-P01',
          providerId: 'DOC-01',
          startTime: '2026-10-01T15:00:00+08:00',
          endTime: '2026-10-01T15:15:00+08:00',
          notes: 'Test checkup',
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      const apptId = created.data.id;
      expect(created.data.rev).toBe(1);

      // Collision test on same slot
      const clashRes = await fetch('http://localhost:4015/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId: 'ZZTEST-P02',
          providerId: 'DOC-01',
          startTime: '2026-10-01T15:00:00+08:00',
          endTime: '2026-10-01T15:15:00+08:00',
        }),
      });
      expect(clashRes.status).toBe(409);

      // Reschedule
      const rescheduleRes = await fetch(`http://localhost:4015/api/appointments/${apptId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startTime: '2026-10-01T16:00:00+08:00',
          endTime: '2026-10-01T16:15:00+08:00',
          expectedRev: 1,
        }),
      });
      expect(rescheduleRes.status).toBe(200);
      const rescheduled = await rescheduleRes.json();
      expect(rescheduled.data.rev).toBe(2);

      // Cancel
      const cancelRes = await fetch(`http://localhost:4015/api/appointments/${apptId}`, {
        method: 'DELETE',
      });
      expect(cancelRes.status).toBe(200);
      const cancelled = await cancelRes.json();
      expect(cancelled.data.status).toBe('cancelled');
      expect(cancelled.data.rev).toBe(3);
    });

    it('simulates out-of-band concurrent edit causing 409 conflict', async () => {
      // 1. Initial appointment rev is 1
      const apptRes = await fetch('http://localhost:4015/api/appointments/APT-001');
      const appt = await apptRes.json();
      expect(appt.data.rev).toBe(1);

      // 2. Out-of-band mutation occurs on CMS backend
      const mutateRes = await fetch('http://localhost:4015/__admin/appointments/APT-001/mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rev: 2 }),
      });
      expect(mutateRes.status).toBe(200);

      // 3. Client attempts update with stale rev 1
      const updateRes = await fetch('http://localhost:4015/api/appointments/APT-001', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: 'Stale update attempt',
          expectedRev: 1,
        }),
      });
      expect(updateRes.status).toBe(409);
      const conflict = await updateRes.json();
      expect(conflict.error).toBe('CONFLICT');
      expect(conflict.currentRev).toBe(2);
    });

    it('supports targeted fault injection without breaking unrelated endpoints', async () => {
      // Set targeted 409 on specific appointment update only
      await fetch('http://localhost:4015/__admin/fault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fault: '409',
          targetPath: '/api/appointments/APT-001',
          method: 'PUT',
        }),
      });

      // Target endpoint returns 409
      const targetedRes = await fetch('http://localhost:4015/api/appointments/APT-001', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'test' }),
      });
      expect(targetedRes.status).toBe(409);

      // Unrelated endpoint continues working normally
      const patientsRes = await fetch('http://localhost:4015/api/patients');
      expect(patientsRes.status).toBe(200);
    });
  });

  describe('Mock Sync API & Adapter Security', () => {
    it('handles device pairing and rejects expired code', async () => {
      const pairRes = await fetch('http://localhost:4016/v1/sync/installations/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairingCode: 'PAIR-TEST-123',
          clientPublicKey: 'PUBKEY_EXAMPLE_MOCK',
        }),
      });
      expect(pairRes.status).toBe(200);
      const pairData = await pairRes.json();
      expect(pairData.installationId).toContain('inst_mock_');
      expect(pairData.targetOrigin).toBe('http://localhost:4015');

      const expiredRes = await fetch('http://localhost:4016/v1/sync/installations/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairingCode: 'EXPIRED',
          clientPublicKey: 'PUBKEY_EXAMPLE_MOCK',
        }),
      });
      expect(expiredRes.status).toBe(400);
    });

    it('manages leader lease with monotonic fencing token', async () => {
      const res1 = await fetch('http://localhost:4016/v1/sync/leases/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'conn_1',
          installationId: 'inst_A',
          durationSeconds: 10,
        }),
      });
      expect(res1.status).toBe(200);
      const lease1 = await res1.json();
      expect(lease1.status).toBe('GRANTED');
      expect(lease1.fencingToken).toBe(1);

      // Conflict from another installation
      const resConflict = await fetch('http://localhost:4016/v1/sync/leases/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'conn_1',
          installationId: 'inst_B',
        }),
      });
      expect(resConflict.status).toBe(409);

      // Release
      const resRelease = await fetch('http://localhost:4016/v1/sync/leases/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'conn_1',
          leaseId: lease1.leaseId,
        }),
      });
      expect(resRelease.status).toBe(200);

      // Acquire again -> fencing token advances to 2
      const res2 = await fetch('http://localhost:4016/v1/sync/leases/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'conn_1',
          installationId: 'inst_B',
        }),
      });
      const lease2 = await res2.json();
      expect(lease2.fencingToken).toBe(2);
    });

    it('deliberately serves signed, tampered, unsigned, unknown_primitive, and invalid manifests', async () => {
      // 1. Valid signed manifest
      const validRes = await fetch('http://localhost:4016/v1/sync/connections/conn_1/adapter?variant=valid');
      const validManifest = await validRes.json();
      expect(validManifest.signature).toBeDefined();
      const isValid = verifyManifestSignature(validManifest, validManifest.signature);
      expect(isValid).toBe(true);

      // 2. Tampered signature
      const tamperedRes = await fetch('http://localhost:4016/v1/sync/connections/conn_1/adapter?variant=tampered');
      const tamperedManifest = await tamperedRes.json();
      const isTamperedValid = verifyManifestSignature(tamperedManifest, tamperedManifest.signature);
      expect(isTamperedValid).toBe(false);

      // 3. Unsigned manifest
      const unsignedRes = await fetch('http://localhost:4016/v1/sync/connections/conn_1/adapter?variant=unsigned');
      const unsignedManifest = await unsignedRes.json();
      expect(unsignedManifest.signature).toBeUndefined();

      // 4. Unknown primitive
      const unknownRes = await fetch('http://localhost:4016/v1/sync/connections/conn_1/adapter?variant=unknown_primitive');
      const unknownManifest = await unknownRes.json();
      expect(unknownManifest.capabilities).toContain('__UNKNOWN_DANGEROUS_EVAL__');

      // 5. Invalid schema
      const invalidRes = await fetch('http://localhost:4016/v1/sync/connections/conn_1/adapter?variant=invalid_schema');
      const invalidManifest = await invalidRes.json();
      expect(invalidManifest.adapterId).toBeUndefined();
    });

    it('records probe results and redacted diagnostics', async () => {
      // 1. Probe result (Phase 10)
      const probeRes = await fetch('http://localhost:4016/v1/sync/connections/conn_1/probe-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: 'inst_1',
          capabilities: ['PATIENT_READ', 'APPOINTMENT_WRITE'],
          cmsVersion: 'v2.4.1',
          passed: true,
        }),
      });
      expect(probeRes.status).toBe(200);
      const probeData = await probeRes.json();
      expect(probeData.status).toBe('ok');

      // 2. Diagnostics (Phase 10)
      const diagRes = await fetch('http://localhost:4016/v1/sync/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: 'inst_1',
          correlationId: 'corr_12345',
          errorType: 'SESSION_EXPIRED',
          redactedDetails: { statusCode: 401 },
        }),
      });
      expect(diagRes.status).toBe(200);
      const diagData = await diagRes.json();
      expect(diagData.status).toBe('recorded');
      expect(diagData.diagnosticId).toContain('diag_');
    });
  });
});
