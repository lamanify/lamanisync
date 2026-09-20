import { MockCmsServer } from '../test-harness/mock-cms/server.js';
import { MockSyncApiServer } from '../test-harness/mock-sync-api/server.js';

const cms = new MockCmsServer(4001);
const sync = new MockSyncApiServer(4002);

async function req(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), data };
}

async function runDemo() {
  await Promise.all([cms.start(), sync.start()]);

  console.log('\n======================================================');
  console.log('DEMO PART 1: Mock CMS Operations');
  console.log('======================================================\n');

  console.log('--- 1. Patients List (GET /api/patients) ---');
  const listRes = await req('http://localhost:4001/api/patients');
  console.log(`HTTP ${listRes.status}`);
  console.log(JSON.stringify(listRes.data, null, 2));

  console.log('\n--- 2. Patient Get (GET /api/patients/ZZTEST-P01) ---');
  const getRes = await req('http://localhost:4001/api/patients/ZZTEST-P01');
  console.log(`HTTP ${getRes.status}`);
  console.log(JSON.stringify(getRes.data, null, 2));

  console.log('\n--- 3. Appointment Create (POST /api/appointments) ---');
  const createRes = await req('http://localhost:4001/api/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patientId: 'ZZTEST-P03',
      providerId: 'DOC-01',
      serviceId: 'SRV-01',
      locationId: 'LOC-01',
      startTime: '2026-10-05T10:00:00+08:00',
      endTime: '2026-10-05T10:15:00+08:00',
      notes: 'New patient intake booking',
    }),
  });
  console.log(`HTTP ${createRes.status}`);
  console.log(JSON.stringify(createRes.data, null, 2));
  const newApptId = createRes.data.data.id;

  console.log(`\n--- 4. Appointment Reschedule (PUT /api/appointments/${newApptId}) ---`);
  const reschedRes = await req(`http://localhost:4001/api/appointments/${newApptId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startTime: '2026-10-05T11:00:00+08:00',
      endTime: '2026-10-05T11:15:00+08:00',
      expectedRev: 1,
      notes: 'Rescheduled upon patient request',
    }),
  });
  console.log(`HTTP ${reschedRes.status}`);
  console.log(JSON.stringify(reschedRes.data, null, 2));

  console.log(`\n--- 5. Appointment Cancel (DELETE /api/appointments/${newApptId}) ---`);
  const cancelRes = await req(`http://localhost:4001/api/appointments/${newApptId}`, {
    method: 'DELETE',
  });
  console.log(`HTTP ${cancelRes.status}`);
  console.log(JSON.stringify(cancelRes.data, null, 2));

  console.log('\n======================================================');
  console.log('DEMO PART 2: Mock Sync API Operations');
  console.log('======================================================\n');

  console.log('--- 6. Pairing Installation (POST /v1/sync/installations/pair) ---');
  const pairRes = await req('http://localhost:4002/v1/sync/installations/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairingCode: 'PAIR-DEMO-001',
      clientPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...',
      deviceName: 'Front Desk Terminal 1',
    }),
  });
  console.log(`HTTP ${pairRes.status}`);
  console.log(JSON.stringify(pairRes.data, null, 2));

  console.log('\n--- 7. Granting Leader Lease (POST /v1/sync/leases/acquire) ---');
  const leaseRes = await req('http://localhost:4002/v1/sync/leases/acquire', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      connectionId: pairRes.data.connectionId,
      installationId: pairRes.data.installationId,
      durationSeconds: 30,
    }),
  });
  console.log(`HTTP ${leaseRes.status}`);
  console.log(JSON.stringify(leaseRes.data, null, 2));

  console.log('\n--- 8. Returning Pending Outbox Command (GET /v1/sync/outbox/next) ---');
  const outboxRes = await req(`http://localhost:4002/v1/sync/outbox/next?connectionId=${pairRes.data.connectionId}`);
  console.log(`HTTP ${outboxRes.status}`);
  console.log(JSON.stringify(outboxRes.data, null, 2));

  console.log('\n======================================================');
  console.log('DEMO PART 3: Deliberate Fault Injections');
  console.log('======================================================\n');

  console.log('--- 9. Fault 401: Unauthorized ---');
  await req('http://localhost:4001/__admin/fault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fault: '401' }),
  });
  const f401 = await req('http://localhost:4001/api/patients');
  console.log(`HTTP ${f401.status}`);
  console.log(JSON.stringify(f401.data, null, 2));

  console.log('\n--- 10. Fault 409: Conflict ---');
  await req('http://localhost:4001/__admin/fault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fault: '409' }),
  });
  const f409 = await req('http://localhost:4001/api/patients');
  console.log(`HTTP ${f409.status}`);
  console.log(JSON.stringify(f409.data, null, 2));

  console.log('\n--- 11. Fault 429: Rate Limited ---');
  await req('http://localhost:4001/__admin/fault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fault: '429' }),
  });
  const f429 = await req('http://localhost:4001/api/patients');
  console.log(`HTTP ${f429.status} (Retry-After: ${f429.headers['retry-after']})`);
  console.log(JSON.stringify(f429.data, null, 2));

  console.log('\n--- 12. Fault 500: Internal Server Error ---');
  await req('http://localhost:4001/__admin/fault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fault: '500' }),
  });
  const f500 = await req('http://localhost:4001/api/patients');
  console.log(`HTTP ${f500.status}`);
  console.log(JSON.stringify(f500.data, null, 2));

  console.log('\n======================================================');
  console.log('DEMO PART 4: Resetting Fixtures & Restoring State');
  console.log('======================================================\n');

  console.log('--- 13. Reset Fixtures (POST /__admin/reset) ---');
  const resetRes = await req('http://localhost:4001/__admin/reset', { method: 'POST' });
  console.log(`HTTP ${resetRes.status}`);
  console.log(JSON.stringify(resetRes.data, null, 2));

  console.log('\n--- 14. Verify Initial State Restored (GET /api/patients) ---');
  const restoredRes = await req('http://localhost:4001/api/patients');
  console.log(`HTTP ${restoredRes.status}`);
  console.log(`Total patients in state: ${restoredRes.data.total}`);
  console.log(`First patient: ${restoredRes.data.data[0].fullName} (${restoredRes.data.data[0].id})`);

  await Promise.all([cms.stop(), sync.stop()]);
  console.log('\nDemo complete. Both servers stopped cleanly.');
}

runDemo().catch((err) => {
  console.error('Demo error:', err);
  process.exit(1);
});
