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
import { EchoSuppressor } from './echo-suppressor.js';
import { CommandExecutor } from './command-executor.js';
import { OutboxPoller, OUTBOX_ALARM_NAME } from './outbox-poller.js';
import { KillSwitchCoordinator } from './kill-switch.js';
import { TokenManager } from './token-manager.js';

export const TOKEN_RENEWAL_ALARM_NAME = 'lamanisync_token_renewal';

export const defaultStorage = {
  get: (keys: string | string[]) =>
    typeof chrome !== 'undefined' && chrome.storage?.local
      ? chrome.storage.local.get(keys)
      : Promise.resolve({}),
  set: (items: Record<string, unknown>) =>
    typeof chrome !== 'undefined' && chrome.storage?.local
      ? chrome.storage.local.set(items)
      : Promise.resolve(),
  remove: (keys: string | string[]) =>
    typeof chrome !== 'undefined' && chrome.storage?.local
      ? chrome.storage.local.remove(keys)
      : Promise.resolve(),
};

export const fsm = new ConnectionFSM();
export const apiClient = new SyncApiClient();
export const coordinator = new PairingCoordinator({ fsm, apiClient, storage: defaultStorage });

export const killSwitch = new KillSwitchCoordinator({
  fsm,
  storage: defaultStorage,
  onPauseTriggered: () => {
    outboxPoller?.stop();
  },
});

export const tokenManager = new TokenManager({
  apiClient,
  storage: defaultStorage,
  fsm,
});

coordinator.setTokenManager(tokenManager);

apiClient.setKillSwitchHandler((payload) => {
  killSwitch.processRemoteSignal(payload);
});

apiClient.setTokenRecoveryHandler(async () => {
  return tokenManager.handleTokenExpired();
});

export const leaseCoordinator = new LeaseCoordinator({ apiClient });
export const dedupeCache = new DeduplicationCache();
export const batchUploader = new BatchUploader({
  apiClient,
  installationId: '',
  dedupeCache,
});
export const referenceSync = new ReferenceSyncManager({ targetOrigin: '' });

export const echoSuppressor = new EchoSuppressor();
export const commandExecutor = new CommandExecutor({
  apiClient,
  leaseCoordinator,
  fsm,
  echoSuppressor,
});
export const outboxPoller = new OutboxPoller({
  apiClient,
  leaseCoordinator,
  commandExecutor,
  fsm,
  connectionId: '',
  killSwitches: {
    isGlobalPaused: () => killSwitch.isGlobalPaused(),
    isAdapterPaused: (id?: string) => (id ? killSwitch.isAdapterPaused(id) : false),
    isConnectionPaused: (id?: string) => (id ? killSwitch.isConnectionPaused(id) : false),
  },
});

// Broadcast FSM state transitions to popup / extension views (Phase 9 reactive state)
fsm.onTransition((record) => {
  if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
    try {
      const p = chrome.runtime.sendMessage({
        type: 'CONNECTION_STATE_CHANGED',
        record,
      });
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        (p as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Ignore when no listener is listening (e.g. popup closed)
    }
  }
});

// Forward lease changes to pairing coordinator and schedule/clear alarms
leaseCoordinator.onLeaseAcquired((lease) => {
  coordinator.setActiveLease({
    connectionId: lease.connectionId,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });

  outboxPoller.setConnectionId(lease.connectionId);
  outboxPoller.start();

  if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
    try {
      chrome.alarms.create('reconcile_check', {
        periodInMinutes: 5,
      });
      chrome.alarms.create(OUTBOX_ALARM_NAME, {
        periodInMinutes: 1,
      });
    } catch (err) {
      console.warn('[LamaniSync SW] Failed to schedule alarms:', err);
    }
  }
});

leaseCoordinator.onLeaseLost(() => {
  coordinator.setActiveLease(null);
  outboxPoller.stop();

  if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
    try {
      chrome.alarms.clear('reconcile_check');
      chrome.alarms.clear(OUTBOX_ALARM_NAME);
    } catch {
      // ignore
    }
  }
});

export const recentObservations: unknown[] = [];
export const MAX_RECENT_OBSERVATIONS = 50;

export function recordObservation(obs: unknown): void {
  if (obs && typeof obs === 'object' && echoSuppressor.shouldSuppressObservation(obs as Record<string, unknown>)) {
    return; // Echo suppressed (AGENTS.md write-loop prevention)
  }
  recentObservations.unshift(obs);
  if (recentObservations.length > MAX_RECENT_OBSERVATIONS) {
    recentObservations.pop();
  }
}

export function clearObservations(): void {
  recentObservations.length = 0;
}

export async function ensureServiceWorkerRestored(): Promise<void> {
  try {
    await killSwitch.restore();
    const activeLease = await leaseCoordinator.restore();
    await echoSuppressor.restoreFromStorage();
    const record = await coordinator.restoreState();
    const session = await coordinator.getSession();
    if (session) {
      batchUploader.setInstallationId(session.installationId);
      referenceSync.setTargetOrigin(session.targetOrigin);
      commandExecutor.setTargetOrigin(session.targetOrigin);
      outboxPoller.setConnectionId(session.connectionId);
      await referenceSync.restore();
      await tokenManager.checkAndRenew();

      if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
        try {
          chrome.alarms.create(TOKEN_RENEWAL_ALARM_NAME, {
            periodInMinutes: 1,
          });
        } catch {
          // Ignore
        }
      }
    }
    if (killSwitch.isPaused({ connectionId: session?.connectionId })) {
      if (fsm.canTransition('PAUSED')) {
        fsm.transition('PAUSED', {
          reason: `Kill-switch active on startup: ${killSwitch.getPauseReason({ connectionId: session?.connectionId })}`,
        });
      }
      outboxPoller.stop();
      return record as unknown as void;
    }
    if (activeLease) {
      coordinator.setActiveLease({
        connectionId: activeLease.connectionId,
        leaseId: activeLease.leaseId,
        fencingToken: activeLease.fencingToken,
      });
      outboxPoller.setConnectionId(activeLease.connectionId);
      outboxPoller.start();
    }
    return record as unknown as void;
  } catch (err) {
    console.error('[LamaniSync SW] Failed to restore service worker state:', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const version = chrome.runtime.getManifest().version;
  console.log(`[LamaniSync Dev] Service Worker installed. Version: ${version}`);
  await ensureServiceWorkerRestored();
});

chrome.runtime.onStartup.addListener(async () => {
  const version = chrome.runtime.getManifest().version;
  console.log(`[LamaniSync Dev] Service Worker started. Version: ${version}`);
  await ensureServiceWorkerRestored();
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
      .then((result) => {
        if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
          try {
            chrome.alarms.create(TOKEN_RENEWAL_ALARM_NAME, {
              periodInMinutes: 1,
            });
          } catch {
            // Ignore
          }
        }
        sendResponse({ success: true, result, record: fsm.getRecord() });
      })
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
      .then(() => {
        if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
          try {
            chrome.alarms.clear(TOKEN_RENEWAL_ALARM_NAME);
          } catch {
            // Ignore
          }
        }
        sendResponse({ success: true, record: fsm.getRecord() });
      })
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

  // --- Phase 8 Outbox & Command Message Handlers ---
  if (message?.type === 'POLL_OUTBOX') {
    outboxPoller
      .pollOnce()
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === 'EXECUTE_COMMAND') {
    commandExecutor
      .executeCommand(message.command)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message?.type === 'GET_OUTBOX_STATE') {
    commandExecutor
      .getInFlightCommand()
      .then((inFlight) => {
        sendResponse({
          isPolling: outboxPoller.isActive(),
          inFlight,
        });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

// Alarm listener for MV3 background lease renewal, periodic reconciliation & outbox polling
if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    await ensureServiceWorkerRestored();

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
            installationId: session.installationId,
            fsm,
          });
          await worker.runReconciliation();
        }
      } catch (err) {
        console.warn('[LamaniSync SW] Reconcile alarm error:', err);
      }
    } else if (alarm.name === OUTBOX_ALARM_NAME) {
      try {
        if (leaseCoordinator.hasActiveLease()) {
          await outboxPoller.pollOnce();
        }
      } catch (err) {
        console.warn('[LamaniSync SW] Outbox poll alarm error:', err);
      }
    } else if (alarm.name === TOKEN_RENEWAL_ALARM_NAME) {
      try {
        await tokenManager.checkAndRenew();
      } catch (err) {
        console.warn('[LamaniSync SW] Token renewal alarm error:', err);
      }
    }
  });
}

