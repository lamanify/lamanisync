/**
 * Service Worker (Phase 4)
 * Ephemeral background coordinator for device identity, pairing, and lifecycle.
 * Conforms strictly to AGENTS.md:
 * Rule 1: Manifest V3 only.
 * Rule 7: Service worker is ephemeral; state survives suspension and restart.
 */

import { ConnectionFSM } from './connection-fsm.js';
import { PairingCoordinator } from './pairing.js';
import { SyncApiClient } from './api-client.js';
import { LeaseCoordinator } from './lease-client.js';
import { DeduplicationCache } from './dedupe.js';
import { BatchUploader } from './batch-uploader.js';
import { ReferenceSyncManager } from './reference-sync.js';
import { ProbeRunner } from './probe.js';
import { BackfillEngine } from './backfill.js';
import { ReconcileWorker } from './reconcile.js';

export const fsm = new ConnectionFSM();
export const apiClient = new SyncApiClient();
export const coordinator = new PairingCoordinator({ fsm, apiClient });

export const leaseCoordinator = new LeaseCoordinator({ apiClient });
export const dedupeCache = new DeduplicationCache();
export const batchUploader = new BatchUploader({
  apiClient,
  installationId: '',
  dedupeCache,
});
export const referenceSync = new ReferenceSyncManager({ targetOrigin: '' });

// Forward lease changes to pairing coordinator
leaseCoordinator.onLeaseAcquired((lease) => {
  coordinator.setActiveLease({
    connectionId: lease.connectionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
});

leaseCoordinator.onLeaseLost(() => {
  coordinator.setActiveLease(null);
});

export const recentObservations: unknown[] = [];
export const MAX_RECENT_OBSERVATIONS = 50;

export function recordObservation(obs: unknown): void {
  recentObservations.unshift(obs);
  if (recentObservations.length > MAX_RECENT_OBSERVATIONS) {
    recentObservations.pop();
  }
}

export function clearObservations(): void {
  recentObservations.length = 0;
}

chrome.runtime.onInstalled.addListener(async () => {
  const version = chrome.runtime.getManifest().version;
  console.log(`[LamaniSync Dev] Service Worker installed. Version: ${version}`);
  try {
    await coordinator.restoreState();
  } catch (err) {
    console.error('[LamaniSync Dev] Failed to restore state on install:', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const version = chrome.runtime.getManifest().version;
  console.log(`[LamaniSync Dev] Service Worker started. Version: ${version}`);
  try {
    await coordinator.restoreState();
  } catch (err) {
    console.error('[LamaniSync Dev] Failed to restore state on startup:', err);
  }
});

// Real-time host permission removal listener (Chrome settings or browser drop)
if (typeof chrome !== 'undefined' && chrome.permissions?.onRemoved) {
  chrome.permissions.onRemoved.addListener(async (removedPermissions) => {
    try {
      await coordinator.handlePermissionsRemoved(removedPermissions);
    } catch (err) {
      console.warn('[LamaniSync Dev] Error handling permission removal:', err);
    }
  });
}

// Runtime messaging for popup and background lifecycle coordination
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_CONNECTION_STATE') {
    // Ephemeral SW fix: Always ensure state is restored from storage before returning record
    coordinator
      .restoreState()
      .then((record) => sendResponse({ record }))
      .catch((err) => sendResponse({ error: err.message, record: fsm.getRecord() }));
    return true; // async response
  }

  if (message?.type === 'PAIR') {
    coordinator
      .pair(message.pairingCode, message.deviceName)
      .then((result) => sendResponse({ success: true, result, record: fsm.getRecord() }))
      .catch((err) => sendResponse({ success: false, error: err.message, code: err.code }));
    return true; // async response
  }

  if (message?.type === 'GRANT_PERMISSION_RESULT') {
    if (message.granted) {
      coordinator
        .grantHostPermission()
        .then((granted) => sendResponse({ success: granted, record: fsm.getRecord() }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
    } else {
      sendResponse({ success: false, error: 'Permission declined' });
    }
    return true; // async response
  }

  if (message?.type === 'UNPAIR') {
    coordinator
      .unpair(message.reason)
      .then(() => sendResponse({ success: true, record: fsm.getRecord() }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }

  if (message?.type === 'RESTORE_STATE') {
    coordinator
      .restoreState()
      .then((record) => sendResponse({ record }))
      .catch((err) => sendResponse({ error: err.message, record: fsm.getRecord() }));
    return true; // async response
  }

  if (message?.type === 'CMS_OBSERVATION') {
    recordObservation(message.payload);
    sendResponse({ received: true });
    return false;
  }

  if (message?.type === 'GET_RECENT_OBSERVATIONS') {
    sendResponse({ observations: [...recentObservations] });
    return false;
  }

  // --- Phase 7 Message Handlers ---
  if (message?.type === 'ACQUIRE_LEASE') {
    coordinator
      .getSession()
      .then(async (session) => {
        if (!session) return sendResponse({ success: false, error: 'Not paired' });
        const duration = typeof message.durationSeconds === 'number' ? message.durationSeconds : 30;
        const acquired = await leaseCoordinator.acquire(session.connectionId, session.installationId, duration);
        sendResponse({ success: acquired, lease: leaseCoordinator.getActiveLease() });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === 'RELEASE_LEASE') {
    leaseCoordinator
      .release()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === 'GET_LEASE_STATE') {
    sendResponse({ lease: leaseCoordinator.getActiveLease() });
    return false;
  }

  if (message?.type === 'RUN_PROBE') {
    coordinator
      .getSession()
      .then(async (session) => {
        if (!session) return sendResponse({ success: false, error: 'Not paired' });
        const runner = new ProbeRunner({
          fsm,
          apiClient,
          targetOrigin: session.targetOrigin,
          connectionId: session.connectionId,
          installationId: session.installationId,
          expectedClinicId: session.clinicId,
        });
        const result = await runner.runProbe();
        sendResponse({ success: true, result, record: fsm.getRecord() });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === 'SYNC_REFERENCE') {
    coordinator
      .getSession()
      .then(async (session) => {
        if (!session) return sendResponse({ success: false, error: 'Not paired' });
        referenceSync.setTargetOrigin(session.targetOrigin);
        const snapshot = await referenceSync.sync();
        sendResponse({ success: true, snapshot });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === 'START_BACKFILL') {
    coordinator
      .getSession()
      .then(async (session) => {
        if (!session) return sendResponse({ success: false, error: 'Not paired' });
        batchUploader.setInstallationId(session.installationId);
        const engine = new BackfillEngine({
          leaseCoordinator,
          fsm,
          batchUploader,
          targetOrigin: session.targetOrigin,
          connectionId: session.connectionId,
          installationId: session.installationId,
          pageSize: message.pageSize,
        });
        const checkpoint = await engine.start();
        sendResponse({ success: true, checkpoint });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === 'RUN_RECONCILE') {
    coordinator
      .getSession()
      .then(async (session) => {
        if (!session) return sendResponse({ success: false, error: 'Not paired' });
        batchUploader.setInstallationId(session.installationId);
        const worker = new ReconcileWorker({
          leaseCoordinator,
          apiClient,
          batchUploader,
          targetOrigin: session.targetOrigin,
          connectionId: session.connectionId,
        });
        const result = await worker.runReconciliation();
        sendResponse({ success: true, result });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});

// Alarm listener for MV3 background lease renewal & periodic reconciliation
if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'lease_renewal') {
      try {
        await leaseCoordinator.renew();
      } catch (err) {
        console.warn('[LamaniSync SW] Lease renewal alarm error:', err);
      }
    } else if (alarm.name === 'reconcile_check') {
      try {
        const session = await coordinator.getSession();
        if (session && leaseCoordinator.hasActiveLease()) {
          batchUploader.setInstallationId(session.installationId);
          const worker = new ReconcileWorker({
            leaseCoordinator,
            apiClient,
            batchUploader,
            targetOrigin: session.targetOrigin,
            connectionId: session.connectionId,
          });
          await worker.runReconciliation();
        }
      } catch (err) {
        console.warn('[LamaniSync SW] Reconcile alarm error:', err);
      }
    }
  });
}

