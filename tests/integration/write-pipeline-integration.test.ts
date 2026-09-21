// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { MockSyncApiServer } from '../../test-harness/mock-sync-api/server.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { LeaseCoordinator } from '../../src/background/lease-client.js';
import { EchoSuppressor } from '../../src/background/echo-suppressor.js';
import { CommandExecutor } from '../../src/background/command-executor.js';
import { OutboxPoller } from '../../src/background/outbox-poller.js';
import { setIndexedDbFactory, getOrCreateDeviceKey } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';
import { type AdapterManifest } from '../../src/adapters/schema.js';

class MemoryStorageAdapter {
  private store = new Map<string, unknown>();

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const list = Array.isArray(keys) ? keys : [keys];
    const res: Record<string, unknown> = {};
    for (const k of list) {
      if (this.store.has(k)) res[k] = this.store.get(k);
    }
    return res;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.store.set(k, v);
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this.store.delete(k);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

describe('Phase 8 Write Pipeline & Read-After-Write Verification Integration Tests', () => {
  const CMS_PORT = 4061;
  const SYNC_PORT = 4062;
  const CMS_URL = `http://localhost:${CMS_PORT}`;
  const SYNC_URL = `http://localhost:${SYNC_PORT}`;

  let cmsServer: MockCmsServer;
  let syncServer: MockSyncApiServer;

  let storage: MemoryStorageAdapter;
  let fsm: ConnectionFSM;
  let apiClient: SyncApiClient;
  let leaseCoordinator: LeaseCoordinator;
  let echoSuppressor: EchoSuppressor;
  let commandExecutor: CommandExecutor;
  let poller: OutboxPoller;

  let installationId: string;
  const connectionId = 'conn_mock_67890';

  const adapterManifest: AdapterManifest = {
    adapterId: 'acme-cloud-v1',
    name: 'ACME Cloud CMS Adapter',
    version: '1.0.0',
    targetOrigin: CMS_URL,
    capabilities: ['PATIENT_READ', 'PATIENT_WRITE', 'APPOINTMENT_READ', 'APPOINTMENT_WRITE'],
    endpoints: {},
  };

  beforeAll(async () => {
    cmsServer = new MockCmsServer(CMS_PORT);
    syncServer = new MockSyncApiServer(SYNC_PORT);
    await Promise.all([cmsServer.start(), syncServer.start()]);
  });

  afterAll(async () => {
    poller?.stop();
    await Promise.all([cmsServer.stop(), syncServer.stop()]);
  });

  beforeEach(async () => {
    cmsServer.reset();
    syncServer.reset();
    syncServer.state.outbox = [];

    const idbFactory = createMockIDBFactory();
    setIndexedDbFactory(idbFactory);
    storage = new MemoryStorageAdapter();

    fsm = new ConnectionFSM({ state: 'ACTIVE' });
    apiClient = new SyncApiClient({
      baseUrl: SYNC_URL,
      idbFactory,
    });

    // Pair device with Sync API
    const { publicKeySpki } = await getOrCreateDeviceKey(idbFactory);
    const pairRes = await apiClient.pair('PAIR-TEST-123', publicKeySpki, 'Write Pipeline Test Device');
    installationId = pairRes.installationId;

    leaseCoordinator = new LeaseCoordinator({
      apiClient,
      defaultDurationSeconds: 30,
      storage,
    });

    // Acquire leader lease
    await leaseCoordinator.acquire(connectionId, installationId, 30);

    echoSuppressor = new EchoSuppressor({ storage });

    commandExecutor = new CommandExecutor({
      apiClient,
      leaseCoordinator,
      fsm,
      echoSuppressor,
      targetOrigin: CMS_URL,
      storage,
    });

    poller = new OutboxPoller({
      apiClient,
      leaseCoordinator,
      commandExecutor,
      fsm,
      connectionId,
      adapterManifest,
      pollIntervalMs: 500,
    });
  });

  it('executes full outbound write lifecycle for CREATE_APPOINTMENT, verifying read-back directly from CMS', async () => {
    // 1. Enqueue create command in Sync API outbox
    const commandPayload = {
      patientId: 'ZZTEST-P01',
      providerId: 'DOC-01',
      serviceId: 'SRV-01',
      locationId: 'LOC-01',
      startTime: '2026-10-02T10:00:00+08:00',
      endTime: '2026-10-02T10:15:00+08:00',
      notes: 'New patient appointment',
    };

    const cmdRes = await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'CREATE_APPOINTMENT',
        payload: commandPayload,
      }),
    });
    const { command } = (await cmdRes.json()) as { command: { commandId: string } };

    // 2. Poll and execute command
    const result = await poller.pollOnce();

    expect(result).not.toBeNull();
    expect(result?.status).toBe('VERIFIED');
    expect(result?.commandId).toBe(command.commandId);
    expect(result?.writeReceipt?.externalId).toMatch(/^APT-/);
    expect(result?.writeReceipt?.revision).toBe(1);

    // 3. Confirm directly against live Mock CMS that appointment was recorded
    const createdId = result?.writeReceipt?.externalId as string;
    const cmsCheck = await fetch(`${CMS_URL}/api/appointments/${createdId}`);
    expect(cmsCheck.status).toBe(200);
    const cmsData = ((await cmsCheck.json()) as { data: Record<string, unknown> }).data;
    expect(cmsData.patientId).toBe('ZZTEST-P01');
    expect(cmsData.providerId).toBe('DOC-01');
    expect(cmsData.status).toBe('booked');

    // 4. Confirm Sync API received VERIFIED receipt
    expect(syncServer.state.receipts).toHaveLength(1);
    expect(syncServer.state.receipts[0].status).toBe('VERIFIED');
    expect(syncServer.state.receipts[0].commandId).toBe(command.commandId);
  });

  it('executes full outbound write lifecycle for RESCHEDULE_APPOINTMENT with revision fencing', async () => {
    // Reschedule existing appointment APT-001 (initial rev: 1)
    const newStartTime = '2026-10-01T16:00:00+08:00';
    const newEndTime = '2026-10-01T16:15:00+08:00';

    const cmdRes = await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'RESCHEDULE_APPOINTMENT',
        payload: {
          appointmentId: 'APT-001',
          startTime: newStartTime,
          endTime: newEndTime,
          expectedRev: 1,
        },
      }),
    });
    const { command } = (await cmdRes.json()) as { command: { commandId: string } };

    const result = await poller.pollOnce();
    expect(result?.status).toBe('VERIFIED');
    expect(result?.commandId).toBe(command.commandId);
    expect(result?.writeReceipt?.externalId).toBe('APT-001');
    expect(result?.writeReceipt?.revision).toBe(2);

    // Verify on CMS
    const cmsCheck = await fetch(`${CMS_URL}/api/appointments/APT-001`);
    const appt = ((await cmsCheck.json()) as { data: Record<string, unknown> }).data;
    expect(appt.startTime).toBe(newStartTime);
    expect(appt.rev).toBe(2);
  });

  it('executes full outbound write lifecycle for CANCEL_APPOINTMENT', async () => {
    const cmdRes = await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'CANCEL_APPOINTMENT',
        payload: {
          appointmentId: 'APT-002',
        },
      }),
    });
    const { command } = (await cmdRes.json()) as { command: { commandId: string } };

    const result = await poller.pollOnce();
    expect(result?.status).toBe('VERIFIED');
    expect(result?.commandId).toBe(command.commandId);

    // Verify on CMS
    const cmsCheck = await fetch(`${CMS_URL}/api/appointments/APT-002`);
    const appt = ((await cmsCheck.json()) as { data: Record<string, unknown> }).data;
    expect(appt.status).toBe('cancelled');
    expect(appt.rev).toBe(2);
  });

  it('ensures exactly ONE appointment is created under simulated network failure via Search-Before-Retry', async () => {
    // Patient & slot details
    const patientId = 'ZZTEST-P01';
    const providerId = 'DOC-01';
    const startTime = '2026-10-02T11:00:00+08:00';
    const endTime = '2026-10-02T11:15:00+08:00';

    // Simulate write already having occurred on CMS before network dropped on response
    await fetch(`${CMS_URL}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId,
        providerId,
        startTime,
        endTime,
        notes: 'Already written before drop',
      }),
    });

    // Enqueue command in outbox for the exact same patient/slot
    await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'CREATE_APPOINTMENT',
        payload: {
          patientId,
          providerId,
          startTime,
          endTime,
        },
      }),
    });

    // Poller executes: search-before-retry detects the existing appointment
    const result = await poller.pollOnce();
    expect(result?.status).toBe('VERIFIED');

    // Query CMS directly for this doctor and time
    const cmsRes = await fetch(`${CMS_URL}/api/appointments?providerId=${providerId}`);
    const cmsList = ((await cmsRes.json()) as { data: Array<Record<string, unknown>> }).data;

    // Filter appointments matching that slot
    const slotAppointments = cmsList.filter((a) => a.startTime === startTime && a.providerId === providerId);
    // EXACTLY 1 appointment created! Zero duplicates
    expect(slotAppointments).toHaveLength(1);
    expect(slotAppointments[0].patientId).toBe(patientId);
  });

  it('triggers CONFLICT status when external staff performed a concurrent edit', async () => {
    // External staff mutates APT-001 out-of-band directly on CMS, bumping revision to 2
    await fetch(`${CMS_URL}/__admin/appointments/APT-001/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 2 }),
    });

    // Outbox has command with stale expectedRev: 1
    await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'RESCHEDULE_APPOINTMENT',
        payload: {
          appointmentId: 'APT-001',
          startTime: '2026-10-01T17:00:00+08:00',
          expectedRev: 1, // Stale revision!
        },
      }),
    });

    const result = await poller.pollOnce();
    expect(result?.status).toBe('CONFLICT');
    expect(result?.error).toBeDefined();

    // Verify receipt reported to Sync API as CONFLICT (never VERIFIED)
    expect(syncServer.state.receipts).toHaveLength(1);
    expect(syncServer.state.receipts[0].status).toBe('CONFLICT');
  });

  it('never reports VERIFIED if read-after-write verification fails (AGENTS.md Rule 10)', async () => {
    // Intercept read-back endpoint with targeted fault returning 409 on GET
    cmsServer.setFault('409', 0, '/api/appointments/APT-001', 'GET');

    await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'RESCHEDULE_APPOINTMENT',
        payload: {
          appointmentId: 'APT-001',
          startTime: '2026-10-01T18:00:00+08:00',
        },
      }),
    });

    const result = await poller.pollOnce();
    expect(result?.status).toBe('CONFLICT');

    // Never VERIFIED
    expect(result?.status).not.toBe('VERIFIED');
    expect(syncServer.state.receipts[0].status).not.toBe('VERIFIED');
  });

  it('multi-workstation safety: second instance without leader lease cannot execute commands', async () => {
    // Second installation
    const idb2 = createMockIDBFactory();
    setIndexedDbFactory(idb2);
    const { publicKeySpki: key2 } = await getOrCreateDeviceKey(idb2);
    const client2 = new SyncApiClient({ baseUrl: SYNC_URL, idbFactory: idb2 });
    await client2.pair('PAIR-TEST-123', key2, 'Second Workstation');

    const lease2 = new LeaseCoordinator({ apiClient: client2 });
    const executor2 = new CommandExecutor({
      apiClient: client2,
      leaseCoordinator: lease2,
      fsm: new ConnectionFSM({ state: 'ACTIVE' }),
      targetOrigin: CMS_URL,
    });
    const poller2 = new OutboxPoller({
      apiClient: client2,
      leaseCoordinator: lease2,
      commandExecutor: executor2,
      fsm: new ConnectionFSM({ state: 'ACTIVE' }),
      connectionId,
    });

    // Enqueue command
    await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'CREATE_APPOINTMENT',
        payload: { patientId: 'ZZTEST-P01', providerId: 'DOC-01', startTime: '2026-10-03T10:00:00+08:00', endTime: '2026-10-03T10:15:00+08:00' },
      }),
    });

    // Second workstation attempts to poll without holding the lease
    const result2 = await poller2.pollOnce();
    expect(result2).toBeNull(); // Skips polling

    // First workstation (holding valid lease) successfully executes
    const result1 = await poller.pollOnce();
    expect(result1?.status).toBe('VERIFIED');
  });

  it('echo suppression prevents outbound write from being re-emitted as an inbound observation', async () => {
    const startTime = '2026-10-04T10:00:00+08:00';
    await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'CREATE_APPOINTMENT',
        payload: {
          patientId: 'ZZTEST-P01',
          providerId: 'DOC-01',
          startTime,
          endTime: '2026-10-04T10:15:00+08:00',
        },
      }),
    });

    const result = await poller.pollOnce();
    const createdId = result?.writeReceipt?.externalId as string;

    // Subsequent observation of the written appointment
    const shouldSuppress = echoSuppressor.shouldSuppressObservation({
      entityType: 'appointment',
      entityId: createdId,
      providerId: 'DOC-01',
      startTime,
    });

    expect(shouldSuppress).toBe(true);
  });

  it('offline or uninstalled extension leaves outbox command pending without confirming', async () => {
    // Release lease to simulate extension going offline
    await leaseCoordinator.release();

    await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'CREATE_APPOINTMENT',
        payload: {
          patientId: 'ZZTEST-P01',
          providerId: 'DOC-01',
          startTime: '2026-10-05T09:00:00+08:00',
          endTime: '2026-10-05T09:15:00+08:00',
        },
      }),
    });

    // Poller attempts when offline / no lease
    const res = await poller.pollOnce();
    expect(res).toBeNull();

    // Check Sync API: zero receipts submitted, appointment remains unconfirmed
    expect(syncServer.state.receipts).toHaveLength(0);
  });

  it('resumes safely following service worker termination mid-execution without creating duplicate records', async () => {
    const patientId = 'ZZTEST-P02';
    const providerId = 'DOC-01';
    const startTime = '2026-10-06T14:00:00+08:00';
    const endTime = '2026-10-06T14:15:00+08:00';

    // 1. Enqueue create command in Sync API outbox
    const cmdRes = await fetch(`${SYNC_URL}/__admin/outbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId,
        actionId: 'CREATE_APPOINTMENT',
        payload: {
          patientId,
          providerId,
          startTime,
          endTime,
          notes: 'Pre-crash booking',
        },
      }),
    });
    const { command } = (await cmdRes.json()) as { command: { commandId: string } };

    // 2. Simulate worker crash after writing mutation to CMS and saving in-flight snapshot
    const writeRes = await fetch(`${CMS_URL}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId,
        providerId,
        startTime,
        endTime,
      }),
    });
    const writtenData = ((await writeRes.json()) as { data: Record<string, unknown> }).data;

    // Snapshot in-flight state in storage as if worker terminated before read-back and result reporting
    await storage.set({
      lamanisync_in_flight_command: {
        commandId: command.commandId,
        action: 'CREATE_APPOINTMENT',
        state: 'EXECUTING',
        fencingToken: 10,
        retryCount: 0,
        lastUpdatedAt: new Date().toISOString(),
      },
    });

    // 3. New service worker instance spins up sharing persistent storage
    const newExecutor = new CommandExecutor({
      apiClient,
      leaseCoordinator,
      fsm,
      echoSuppressor,
      targetOrigin: CMS_URL,
      storage,
    });

    // In-flight command is detected
    const inFlight = await newExecutor.getInFlightCommand();
    expect(inFlight).not.toBeNull();
    expect(inFlight?.commandId).toBe(command.commandId);

    // 4. Poller pulls command again upon restart/retry
    const newPoller = new OutboxPoller({
      apiClient,
      leaseCoordinator,
      commandExecutor: newExecutor,
      fsm,
      connectionId,
      adapterManifest,
      pollIntervalMs: 500,
    });

    // Execute recovery cycle
    const result = await newPoller.pollOnce();
    expect(result).not.toBeNull();
    expect(result?.status).toBe('VERIFIED');
    expect(result?.writeReceipt?.externalId).toBe(writtenData.id);

    // In-flight transient state cleared
    const inFlightAfter = await newExecutor.getInFlightCommand();
    expect(inFlightAfter).toBeNull();

    // Verify on CMS: EXACTLY 1 appointment created on this slot, zero duplicate
    const cmsCheck = await fetch(`${CMS_URL}/api/appointments?providerId=${providerId}`);
    const cmsList = ((await cmsCheck.json()) as { data: Array<Record<string, unknown>> }).data;
    const matching = cmsList.filter((a) => a.startTime === startTime && a.patientId === patientId);
    expect(matching).toHaveLength(1);
  });
});
