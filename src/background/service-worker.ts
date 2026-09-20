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

export const fsm = new ConnectionFSM();
export const apiClient = new SyncApiClient();
export const coordinator = new PairingCoordinator({ fsm, apiClient });

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

  return false;
});
