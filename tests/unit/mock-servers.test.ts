// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { MockSyncApiServer } from '../../test-harness/mock-sync-api/server.js';

describe('Local Test Harness Mock Servers', () => {
  const cmsServer = new MockCmsServer(4001);
  const syncServer = new MockSyncApiServer(4002);

  beforeAll(async () => {
    await Promise.all([cmsServer.start(), syncServer.start()]);
  });

  afterAll(async () => {
    await Promise.all([cmsServer.stop(), syncServer.stop()]);
  });

  beforeEach(async () => {
    await fetch('http://localhost:4001/__admin/reset', { method: 'POST' });
    await fetch('http://localhost:4002/__admin/reset', { method: 'POST' });
  });

  describe('Mock CMS API', () => {
    it('returns synthetic patient list', async () => {
      const res = await fetch('http://localhost:4001/api/patients');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(4);
      expect(body.data[0].id).toBe('ZZTEST-P01');
      expect(body.data[0].fullName).toBe('ZZTEST Patient 01');
    });

    it('returns single patient by ID and 404 for unknown', async () => {
      const res = await fetch('http://localhost:4001/api/patients/ZZTEST-P01');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.fullName).toBe('ZZTEST Patient 01');

      const notFound = await fetch('http://localhost:4001/api/patients/UNKNOWN');
      expect(notFound.status).toBe(404);
    });

    it('creates new synthetic patient', async () => {
      const res = await fetch('http://localhost:4001/api/patients', {
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

    it('creates, reschedules, and cancels appointments', async () => {
      // 1. Create appointment
      const createRes = await fetch('http://localhost:4001/api/appointments', {
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

      // 2. Collision test on same slot
      const clashRes = await fetch('http://localhost:4001/api/appointments', {
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

      // 3. Reschedule
      const rescheduleRes = await fetch(`http://localhost:4001/api/appointments/${apptId}`, {
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

      // 4. Cancel
      const cancelRes = await fetch(`http://localhost:4001/api/appointments/${apptId}`, {
        method: 'DELETE',
      });
      expect(cancelRes.status).toBe(200);
      const cancelled = await cancelRes.json();
      expect(cancelled.data.status).toBe('cancelled');
      expect(cancelled.data.rev).toBe(3);
    });

    it('injects deliberate faults via header and global admin switch', async () => {
      // 401 via header
      const res401 = await fetch('http://localhost:4001/api/patients', {
        headers: { 'x-mock-fault': '401' },
      });
      expect(res401.status).toBe(401);

      // 409 via header
      const res409 = await fetch('http://localhost:4001/api/patients', {
        headers: { 'x-mock-fault': '409' },
      });
      expect(res409.status).toBe(409);

      // 429 via header
      const res429 = await fetch('http://localhost:4001/api/patients', {
        headers: { 'x-mock-fault': '429' },
      });
      expect(res429.status).toBe(429);
      expect(res429.headers.get('retry-after')).toBe('30');

      // 500 via global switch
      await fetch('http://localhost:4001/__admin/fault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fault: '500' }),
      });
      const res500 = await fetch('http://localhost:4001/api/patients');
      expect(res500.status).toBe(500);

      // Reset
      await fetch('http://localhost:4001/__admin/reset', { method: 'POST' });
      const resHealthy = await fetch('http://localhost:4001/api/patients');
      expect(resHealthy.status).toBe(200);
    });
  });

  describe('Mock Sync API', () => {
    it('handles device pairing and rejects expired code', async () => {
      const pairRes = await fetch('http://localhost:4002/v1/sync/installations/pair', {
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
      expect(pairData.targetOrigin).toBe('http://localhost:4001');

      const expiredRes = await fetch('http://localhost:4002/v1/sync/installations/pair', {
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
      const res1 = await fetch('http://localhost:4002/v1/sync/leases/acquire', {
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
      const resConflict = await fetch('http://localhost:4002/v1/sync/leases/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'conn_1',
          installationId: 'inst_B',
        }),
      });
      expect(resConflict.status).toBe(409);

      // Release
      const resRelease = await fetch('http://localhost:4002/v1/sync/leases/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'conn_1',
          leaseId: lease1.leaseId,
        }),
      });
      expect(resRelease.status).toBe(200);

      // Acquire again -> fencing token advances to 2
      const res2 = await fetch('http://localhost:4002/v1/sync/leases/acquire', {
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

    it('serves adapter manifest and dispatches outbox commands', async () => {
      // 1. Adapter manifest
      const adapterRes = await fetch('http://localhost:4002/v1/sync/connections/conn_1/adapter');
      expect(adapterRes.status).toBe(200);
      const adapter = await adapterRes.json();
      expect(adapter.adapterId).toBe('acme-cloud-v1');

      // 2. Outbox next
      const outboxRes = await fetch('http://localhost:4002/v1/sync/outbox/next?connectionId=conn_mock_67890');
      expect(outboxRes.status).toBe(200);
      const outbox = await outboxRes.json();
      expect(outbox.command.commandId).toBe('CMD-TEST-001');
      expect(outbox.command.actionId).toBe('CREATE_APPOINTMENT');

      // 3. Command result submission
      const resultRes = await fetch(`http://localhost:4002/v1/sync/outbox/${outbox.command.commandId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'VERIFIED',
          writeReceipt: {
            externalId: 'APT-001',
            revision: 1,
            verifiedAt: new Date().toISOString(),
          },
        }),
      });
      expect(resultRes.status).toBe(200);
      const resultData = await resultRes.json();
      expect(resultData.acknowledged).toBe(true);
      expect(resultData.status).toBe('VERIFIED');
    });
  });
});
