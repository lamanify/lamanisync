// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { MockSyncApiServer } from '../../test-harness/mock-sync-api/server.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { LeaseCoordinator } from '../../src/background/lease-client.js';
import { DeduplicationCache } from '../../src/background/dedupe.js';
import { BatchUploader } from '../../src/background/batch-uploader.js';
import { ProbeRunner } from '../../src/background/probe.js';
import { ReferenceSyncManager } from '../../src/background/reference-sync.js';
import { BackfillEngine, type StorageAdapter } from '../../src/background/backfill.js';
import { ReconcileWorker } from '../../src/background/reconcile.js';
import { setIndexedDbFactory, getOrCreateDeviceKey } from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';

class MemoryStorageAdapter implements StorageAdapter {
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

describe('Phase 7 Read Pipeline & Leader Lease Integration Tests', () => {
  const CMS_PORT = 4051;
  const SYNC_PORT = 4052;
  const CMS_URL = `http://localhost:${CMS_PORT}`;
  const SYNC_URL = `http://localhost:${SYNC_PORT}`;

  let cmsServer: MockCmsServer;
  let syncServer: MockSyncApiServer;

  let storage: MemoryStorageAdapter;
  let fsm: ConnectionFSM;
  let apiClient: SyncApiClient;
  let leaseCoordinator: LeaseCoordinator;
  let dedupeCache: DeduplicationCache;
  let batchUploader: BatchUploader;

  let installationId: string;
  const connectionId = 'conn_mock_67890';

  const getServerEvents = () => syncServer.state.events as Array<{ entityId: string; entityType: string; [key: string]: unknown }>;

  beforeAll(async () => {
    cmsServer = new MockCmsServer(CMS_PORT);
    syncServer = new MockSyncApiServer(SYNC_PORT);
    await Promise.all([cmsServer.start(), syncServer.start()]);
  });

  afterAll(async () => {
    await Promise.all([cmsServer.stop(), syncServer.stop()]);
  });

  beforeEach(async () => {
    cmsServer.reset();
    syncServer.reset();

    const idbFactory = createMockIDBFactory();
    setIndexedDbFactory(idbFactory);
    storage = new MemoryStorageAdapter();

    fsm = new ConnectionFSM({ state: 'PROBING' });
    apiClient = new SyncApiClient({
      baseUrl: SYNC_URL,
      idbFactory,
    });

    // Pair device with Sync API
    const { publicKeySpki } = await getOrCreateDeviceKey(idbFactory);
    const pairRes = await apiClient.pair('PAIR-TEST-123', publicKeySpki, 'Integration Test Profile');
    installationId = pairRes.installationId;

    leaseCoordinator = new LeaseCoordinator({
      apiClient,
      defaultDurationSeconds: 15,
      storage,
    });

    dedupeCache = new DeduplicationCache();
    batchUploader = new BatchUploader({
      apiClient,
      installationId,
      maxBatchSize: 10,
      dedupeCache,
    });
  });

  it('runs full probe and transitions FSM from PROBING to ACTIVE', async () => {
    const probeRunner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      expectedClinicId: 'CLN-001',
      headers: { Cookie: 'cms_session=dummy_staff_cookie' },
    });

    const result = await probeRunner.runProbe();

    expect(result.passed).toBe(true);
    expect(result.capabilities).toContain('PATIENT_READ');
    expect(result.capabilities).toContain('REFERENCE_DATA_READ');
    expect(fsm.getState()).toBe('ACTIVE');

    // Verify probe recorded in Mock Sync API
    expect(syncServer.state.probeResults.has(connectionId)).toBe(true);
  });

  it('ingests and caches reference data (providers, services, locations)', async () => {
    const refManager = new ReferenceSyncManager({
      targetOrigin: CMS_URL,
      storage,
    });

    const snapshot = await refManager.sync();
    expect(snapshot.providers.length).toBeGreaterThan(0);
    expect(snapshot.services.length).toBeGreaterThan(0);
    expect(snapshot.locations.length).toBeGreaterThan(0);

    expect(refManager.getProvider('DOC-01')?.fullName).toBe('Dr. Siti Aminah');
    expect(refManager.getService('SRV-01')?.name).toBe('General Consultation');
    expect(refManager.getLocation('LOC-01')?.name).toBe('Consultation Room 1');
  });

  it('orchestrates paginated backfill and resumes cleanly from persisted checkpoint across restart', async () => {
    // Acquire leader lease
    const acquired = await leaseCoordinator.acquire(connectionId, installationId, 30);
    expect(acquired).toBe(true);

    // Initialize BackfillEngine with pageSize 2 (Mock CMS has 4 patients: P01, P02, P03, P04)
    const engine1 = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      pageSize: 2,
      storage,
    });

    // Execute step 1 (page 1)
    const hasMore1 = await engine1.step();
    expect(hasMore1).toBe(true);

    const cp1 = engine1.getCheckpoint();
    expect(cp1.cursor).toBe(2);
    expect(cp1.processedCount).toBe(2);

    // Verify 2 patient events recorded on Sync API
    expect(syncServer.state.events.length).toBe(2);
    expect(getServerEvents().map((e) => e.entityId)).toEqual(['ZZTEST-P01', 'ZZTEST-P02']);

    // --- SIMULATE SERVICE WORKER SUSPENSION / TERMINATION & RESTART ---
    // Simulate SW restart: create completely fresh LeaseCoordinator and BackfillEngine instances
    leaseCoordinator.destroy();
    const restartedLeaseCoordinator = new LeaseCoordinator({
      apiClient,
      defaultDurationSeconds: 15,
      storage,
    });
    const restoredLease = await restartedLeaseCoordinator.restore();
    expect(restoredLease).not.toBeNull();
    expect(restartedLeaseCoordinator.hasActiveLease()).toBe(true);

    const engine2 = new BackfillEngine({
      leaseCoordinator: restartedLeaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      pageSize: 2,
      storage,
    });

    await engine2.restoreCheckpoint();
    expect(engine2.getCheckpoint().cursor).toBe(2);
    expect(engine2.getCheckpoint().processedCount).toBe(2);

    // Execute step 2 (resuming from page 2)
    await engine2.step();

    // Verify all 4 patients are now ingested in Sync API without duplicates
    const allPatientEvents = getServerEvents().filter((e) => e.entityType === 'patient');
    expect(allPatientEvents.length).toBe(4);
    expect(allPatientEvents.map((e) => e.entityId)).toEqual([
      'ZZTEST-P01',
      'ZZTEST-P02',
      'ZZTEST-P03',
      'ZZTEST-P04',
    ]);
  });

  it('deduplicates delivered events so zero duplicates are ingested into Sync API', async () => {
    await leaseCoordinator.acquire(connectionId, installationId, 30);

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      pageSize: 4,
      storage,
    });

    // Step 1 ingests 4 patients
    await engine.step();
    expect(syncServer.state.events.length).toBe(4);

    // Re-send page 1 manually via batch uploader to simulate duplicate delivery
    const duplicatePatients = [
      { id: 'ZZTEST-P01', fullName: 'ZZTEST Patient 01', phone: '+60123456701' },
      { id: 'ZZTEST-P02', fullName: 'ZZTEST Patient 02', phone: '+60123456702' },
    ];

    const duplicateEvents = duplicatePatients.map((p) => ({
      eventId: `evt_dup_${p.id}`,
      entityType: 'patient',
      entityId: p.id,
      eventType: 'PATIENT_SYNCED',
      revision: 1,
      occurredAt: new Date().toISOString(),
      payload: p,
    }));

    await batchUploader.enqueue(duplicateEvents);
    await batchUploader.flush();

    // Verification: Zero duplicate events were sent to Sync API
    expect(syncServer.state.events.length).toBe(4);
  });

  it('retains checkpoint cursor if Sync API batch upload fails', async () => {
    await leaseCoordinator.acquire(connectionId, installationId, 30);

    // Force Sync API to fail by pointing to bad endpoint
    const badApiClient = new SyncApiClient({ baseUrl: 'http://localhost:9999' });
    const badBatchUploader = new BatchUploader({
      apiClient: badApiClient,
      installationId,
      maxBatchSize: 10,
    });

    const failingEngine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader: badBatchUploader,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      pageSize: 2,
      storage,
    });

    await expect(failingEngine.step()).rejects.toThrow();

    // Checkpoint cursor MUST remain 1
    expect(failingEngine.getCheckpoint().cursor).toBe(1);
    expect(failingEngine.getCheckpoint().processedCount).toBe(0);
  });

  it('halts backfill immediately if leader lease expires or is not held', async () => {
    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      storage,
    });

    // Attempting backfill without lease throws NO_ACTIVE_LEASE
    await expect(engine.step()).rejects.toThrow('No active leader lease');
    expect(engine.getCheckpoint().status).toBe('PAUSED');
  });

  it('transitions connection FSM to REAUTH_REQUIRED when CMS responds with 401 Unauthorized', async () => {
    await leaseCoordinator.acquire(connectionId, installationId, 30);
    cmsServer.setFault('401');

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      storage,
    });

    const hasMore = await engine.step();
    expect(hasMore).toBe(false);
    expect(fsm.getState()).toBe('REAUTH_REQUIRED');
    expect(engine.getCheckpoint().status).toBe('PAUSED');
  });

  it('respects Retry-After and pauses when CMS responds with 429 Rate Limit', async () => {
    await leaseCoordinator.acquire(connectionId, installationId, 30);
    cmsServer.setFault('429');

    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      storage,
    });

    const hasMore = await engine.step();
    expect(hasMore).toBe(false);
    expect(engine.getCheckpoint().status).toBe('PAUSED');
    expect(engine.getCheckpoint().retryAfterSeconds).toBe(30);
  });

  it('detects and repairs deliberately missed events during reconciliation pass', async () => {
    await leaseCoordinator.acquire(connectionId, installationId, 30);

    // First backfill all patients and appointments to completion
    const engine = new BackfillEngine({
      leaseCoordinator,
      fsm,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId,
      installationId,
      pageSize: 4,
      storage,
    });
    const cp = await engine.start();
    expect(cp.status).toBe('COMPLETED');
    expect(syncServer.state.events.length).toBe(6);

    // Deliberately simulate a missed/dropped event: delete ZZTEST-P02 from Sync API events
    const droppedIndex = getServerEvents().findIndex((e) => e.entityId === 'ZZTEST-P02');
    expect(droppedIndex).toBeGreaterThanOrEqual(0);
    syncServer.state.events.splice(droppedIndex, 1);
    expect(syncServer.state.events.length).toBe(5);

    // Run reconciliation worker
    const worker = new ReconcileWorker({
      leaseCoordinator,
      apiClient,
      batchUploader,
      targetOrigin: CMS_URL,
      connectionId,
    });

    const result = await worker.runReconciliation();

    expect(result.status).toBe('REPAIRED');
    expect(result.repairedCount).toBe(1);
    expect(result.repairedIds).toContain('ZZTEST-P02');

    // Verify ZZTEST-P02 has been restored to Sync API events
    const restoredEvent = getServerEvents().find((e) => e.entityId === 'ZZTEST-P02');
    expect(restoredEvent).toBeDefined();
    expect(restoredEvent?.entityId).toBe('ZZTEST-P02');
  });
});
