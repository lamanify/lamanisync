/**
 * Pairing Coordinator (Phase 4)
 * Manages device pairing handshake, session credential persistence,
 * state restoration across service worker lifecycle, and unpair/revocation.
 * Adheres strictly to AGENTS.md Rules:
 * Rule 4: Zero storage of CMS passwords, cookies, or secrets.
 * Rule 6: No raw PHI stored in chrome.storage.local.
 * Rule 7: Service worker is ephemeral; state survives suspension and restart.
 */

import { z } from 'zod';
import { TargetOriginSchema } from '../core/contracts/primitives.js';
import type { ConnectionStateRecord } from '../core/contracts/connection.js';
import { ConnectionFSM } from './connection-fsm.js';
import { SyncApiClient, type PairingResponse } from './api-client.js';
import { getOrCreateDeviceKey, purgeDeviceKey } from '../storage/device-key.js';
import {
  hasOriginPermission,
  removeOriginPermission,
  requestOriginPermission,
  type ChromePermissionsApi,
} from './permissions.js';
import {
  registerDynamicContentScripts,
  unregisterDynamicContentScripts,
  type ChromeScriptingApi,
} from '../content/registration.js';
import { LamaniError } from '../core/errors.js';

export const SESSION_STORAGE_KEY = 'lamanisync_connection_session';

export const ConnectionSessionSchema = z.object({
  installationId: z.string().min(1),
  connectionId: z.string().min(1),
  clinicId: z.string().min(1),
  sessionToken: z.string().min(1),
  expiresAt: z.string().min(1),
  targetOrigin: TargetOriginSchema,
  pairedAt: z.string().min(1),
  lastReadAt: z.string().optional(),
  lastWriteAt: z.string().optional(),
});

export type ConnectionSession = z.infer<typeof ConnectionSessionSchema>;

export interface StorageAdapter {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function getDefaultStorage(): StorageAdapter {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return {
      get: (keys) => chrome.storage.local.get(keys),
      set: (items) => chrome.storage.local.set(items),
      remove: (keys) => chrome.storage.local.remove(keys),
    };
  }
  throw new Error('chrome.storage.local is not available');
}

export interface PairingCoordinatorOptions {
  fsm: ConnectionFSM;
  apiClient?: SyncApiClient;
  storage?: StorageAdapter;
  permissionsApi?: ChromePermissionsApi;
  scriptingApi?: ChromeScriptingApi;
  idbFactory?: IDBFactory;
  tokenManager?: { renewToken(): Promise<ConnectionSession> };
}

export interface ActiveLeaseRecord {
  connectionId: string;
  leaseId: string;
  fencingToken: number;
}

export class PairingCoordinator {
  readonly fsm: ConnectionFSM;
  readonly apiClient: SyncApiClient;
  private storage: StorageAdapter;
  private permissionsApi?: ChromePermissionsApi;
  private scriptingApi?: ChromeScriptingApi;
  private idbFactory?: IDBFactory;
  private isPairingInFlight: boolean = false;
  private isUnpairingInFlight: boolean = false;
  private activeLease: ActiveLeaseRecord | null = null;
  private tokenManager?: { renewToken(): Promise<ConnectionSession> };

  constructor(options: PairingCoordinatorOptions) {
    this.fsm = options.fsm;
    this.apiClient = options.apiClient || new SyncApiClient({ idbFactory: options.idbFactory });
    if (options.idbFactory && !options.apiClient) {
      this.apiClient.setIdbFactory(options.idbFactory);
    }
    this.storage = options.storage || getDefaultStorage();
    this.permissionsApi = options.permissionsApi;
    this.scriptingApi = options.scriptingApi;
    this.idbFactory = options.idbFactory;
    this.tokenManager = options.tokenManager;
  }

  setTokenManager(tokenManager: { renewToken(): Promise<ConnectionSession> }): void {
    this.tokenManager = tokenManager;
  }

  setStorage(storage: StorageAdapter): void {
    this.storage = storage;
  }

  setPermissionsApi(api: ChromePermissionsApi): void {
    this.permissionsApi = api;
  }

  setScriptingApi(api: ChromeScriptingApi): void {
    this.scriptingApi = api;
  }

  private hasScriptingCapability(): boolean {
    return Boolean(this.scriptingApi || (typeof chrome !== 'undefined' && chrome.scripting));
  }

  setActiveLease(lease: ActiveLeaseRecord | null): void {
    this.activeLease = lease;
  }

  getActiveLease(): ActiveLeaseRecord | null {
    return this.activeLease;
  }

  /**
   * Retrieves active connection session from storage if valid and unexpired.
   */
  async getSession(): Promise<ConnectionSession | null> {
    const data = await this.storage.get(SESSION_STORAGE_KEY);
    const raw = data[SESSION_STORAGE_KEY];
    if (!raw) return null;

    const parsed = ConnectionSessionSchema.safeParse(raw);
    if (!parsed.success) {
      await this.storage.remove(SESSION_STORAGE_KEY);
      return null;
    }

    return parsed.data;
  }

  /**
   * Checks whether the current session has expired.
   */
  isSessionExpired(session: ConnectionSession): boolean {
    const expiryMs = new Date(session.expiresAt).getTime();
    return Number.isNaN(expiryMs) || expiryMs <= Date.now();
  }

  /**
   * Executes the pairing handshake with LamaniHub Mock Sync API.
   * On success: stores connection session and transitions FSM to PAIRED_NO_PERMISSION.
   * On failure: resets FSM to UNPAIRED and throws classified non-PHI error.
   */
  async pair(pairingCode: string, deviceName?: string, targetOrigin?: string): Promise<PairingResponse> {
    const cleanCode = pairingCode.trim();
    if (!cleanCode) {
      throw new LamaniError('Pairing code cannot be empty', 'VALIDATION_ERROR', { statusCode: 400 });
    }

    if (this.isPairingInFlight || this.fsm.getState() === 'PAIRING') {
      throw new LamaniError('Pairing handshake is already in progress', 'CONCURRENT_OPERATION', { statusCode: 409 });
    }

    if (this.isUnpairingInFlight) {
      throw new LamaniError('Cannot pair while unpair is in progress', 'CONCURRENT_OPERATION', { statusCode: 409 });
    }

    this.isPairingInFlight = true;

    // Step 1: Transition FSM to PAIRING
    if (this.fsm.canTransition('PAIRING')) {
      this.fsm.transition('PAIRING', { reason: 'Initiating pairing handshake' });
    }

    try {
      // Step 2: Retrieve or generate WebCrypto ECDSA device key
      const { publicKeySpki } = await getOrCreateDeviceKey(this.idbFactory);

      // Step 3: Request pairing from Sync API
      const result = await this.apiClient.pair(cleanCode, publicKeySpki, deviceName, targetOrigin);

      // Step 4: Persist connection metadata (Zero CMS credentials / PHI)
      const session: ConnectionSession = {
        installationId: result.installationId,
        connectionId: result.connectionId,
        clinicId: result.clinicId,
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
        targetOrigin: result.targetOrigin,
        pairedAt: new Date().toISOString(),
      };

      await this.storage.set({ [SESSION_STORAGE_KEY]: session });

      // Step 5: Transition FSM to PAIRED_NO_PERMISSION
      this.fsm.transition('PAIRED_NO_PERMISSION', {
        reason: 'Pairing handshake successful',
        connectionId: session.connectionId,
        installationId: session.installationId,
        targetOrigin: session.targetOrigin,
        metadata: {
          clinicId: session.clinicId,
          expiresAt: session.expiresAt,
        },
      });

      return result;
    } catch (err) {
      // Revert FSM to UNPAIRED
      if (this.fsm.canTransition('UNPAIRED')) {
        this.fsm.transition('UNPAIRED', {
          reason: `Pairing handshake failed: ${(err as Error).message || 'unknown error'}`,
        });
      }
      throw err;
    } finally {
      this.isPairingInFlight = false;
    }
  }

  /**
   * Prompts the user for host permission covering ONLY the exact paired CMS origin.
   * In popup context, this triggers browser prompt via user gesture.
   */
  async grantHostPermission(): Promise<boolean> {
    const session = await this.getSession();
    if (!session) {
      throw new LamaniError('Cannot grant permission: device is not paired', 'NOT_PAIRED');
    }

    let granted = false;
    if (this.permissionsApi) {
      granted = await requestOriginPermission(
        session.targetOrigin,
        session.targetOrigin,
        this.permissionsApi
      );
    } else {
      granted = await hasOriginPermission(session.targetOrigin);
    }

    if (granted) {
      if (this.hasScriptingCapability()) {
        try {
          await registerDynamicContentScripts(session.targetOrigin, { scriptingApi: this.scriptingApi });
        } catch (err) {
          console.warn('[PairingCoordinator] Dynamic script registration warning:', err);
        }
      }

      if (this.fsm.canTransition('PROBING')) {
        this.fsm.transition('PROBING', {
          reason: 'User granted exact CMS origin permission',
          connectionId: session.connectionId,
          installationId: session.installationId,
          targetOrigin: session.targetOrigin,
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Unpairs the device cleanly:
   * 1. Releases active leader leases (if any).
   * 2. Revokes installation on LamaniHub Sync API.
   * 3. Drops host permissions via chrome.permissions.remove and unregisters dynamic scripts.
   * 4. Purges WebCrypto device private key and IndexedDB records.
   * 5. Clears chrome.storage.local session metadata.
   * 6. Transitions FSM to REVOKED and then UNPAIRED.
   */
  async unpair(reason: string = 'User initiated unpair'): Promise<void> {
    if (this.isUnpairingInFlight) {
      return;
    }

    this.isUnpairingInFlight = true;

    try {
      const session = await this.getSession();

      // 1. Release active leader leases (if any)
      if (this.activeLease && session?.connectionId) {
        try {
          await this.apiClient.releaseLease(session.connectionId, this.activeLease.leaseId);
          this.activeLease = null;
        } catch (err) {
          console.warn('[PairingCoordinator] Lease release warning:', err);
        }
      }

      // 2. Revoke on server (best effort)
      if (session?.installationId) {
        try {
          await this.apiClient.revoke(session.installationId);
        } catch (err) {
          console.warn('[PairingCoordinator] Server revocation warning:', err);
        }
      }

      // 3. Unregister dynamic scripts & remove runtime host permission
      if (this.hasScriptingCapability()) {
        try {
          await unregisterDynamicContentScripts(this.scriptingApi);
        } catch (err) {
          console.warn('[PairingCoordinator] Script unregistration warning:', err);
        }
      }

      if (session?.targetOrigin) {
        try {
          await removeOriginPermission(session.targetOrigin, this.permissionsApi);
        } catch (err) {
          console.warn('[PairingCoordinator] Permission removal warning:', err);
        }
      }

      // 4. Purge device key from IndexedDB
      try {
        await purgeDeviceKey(this.idbFactory);
      } catch (err) {
        console.warn('[PairingCoordinator] Device key purge warning:', err);
      }

      // 5. Purge storage
      await this.storage.remove(SESSION_STORAGE_KEY);
      this.apiClient.setSessionToken(null);

      // 6. Transition FSM
      if (this.fsm.canTransition('REVOKED')) {
        this.fsm.transition('REVOKED', { reason });
      }

      if (this.fsm.canTransition('UNPAIRED')) {
        this.fsm.transition('UNPAIRED', { reason: 'Unpair complete' });
      }
    } finally {
      this.isUnpairingInFlight = false;
    }
  }

  /**
   * Handles real-time host permission removal (e.g. from chrome.permissions.onRemoved).
   */
  async handlePermissionsRemoved(removedPermissions: chrome.permissions.Permissions): Promise<void> {
    const session = await this.getSession();
    if (!session?.targetOrigin) return;

    const pattern = `${session.targetOrigin}/*`;
    const removedOrigins = removedPermissions.origins || [];
    const isTargetRemoved = removedOrigins.some(
      (origin) => origin === pattern || origin === `${session.targetOrigin}/` || origin === session.targetOrigin
    );

    if (isTargetRemoved) {
      if (this.hasScriptingCapability()) {
        try {
          await unregisterDynamicContentScripts(this.scriptingApi);
        } catch (err) {
          console.warn('[PairingCoordinator] Script unregistration warning on removal:', err);
        }
      }

      if (this.fsm.canTransition('PAIRED_NO_PERMISSION')) {
        this.fsm.transition('PAIRED_NO_PERMISSION', {
          reason: 'Host permission was revoked by user or browser',
          connectionId: session.connectionId,
          installationId: session.installationId,
          targetOrigin: session.targetOrigin,
        });
      }
    }
  }

  /**
   * Restores connection state on service worker startup / restart / wakeup.
   * Validates stored credentials, checks expiry, and confirms runtime host permissions.
   * Handles bidirectional transitions if permissions were granted or revoked externally.
   */
  async restoreState(): Promise<ConnectionStateRecord> {
    let session = await this.getSession();

    if (!session) {
      if (this.fsm.getState() !== 'UNPAIRED' && this.fsm.canTransition('UNPAIRED')) {
        this.fsm.transition('UNPAIRED', { reason: 'No valid session on startup' });
      }
      return this.fsm.getRecord();
    }

    if (this.isSessionExpired(session)) {
      let renewed = false;
      try {
        if (this.tokenManager) {
          session = await this.tokenManager.renewToken();
          renewed = Boolean(session?.sessionToken && session?.expiresAt);
        } else {
          const renewal = await this.apiClient.renewSessionToken(session.installationId);
          if (renewal?.sessionToken && renewal?.expiresAt) {
            session = {
              ...session,
              sessionToken: renewal.sessionToken,
              expiresAt: renewal.expiresAt,
            };
            await this.storage.set({ [SESSION_STORAGE_KEY]: session });
            renewed = true;
          }
        }
      } catch (err) {
        console.warn('[PairingCoordinator] Failed to renew expired session token on restore:', err);
      }

      if (!renewed) {
        await this.storage.remove(SESSION_STORAGE_KEY);
        if (this.fsm.getState() !== 'UNPAIRED' && this.fsm.canTransition('UNPAIRED')) {
          this.fsm.transition('UNPAIRED', { reason: 'Session token expired and cannot be renewed on startup' });
        }
        return this.fsm.getRecord();
      }
    }

    // Configure API client with restored session token
    this.apiClient.setSessionToken(session.sessionToken);

    // Verify whether runtime host permission is active
    let hasPerm = false;
    try {
      hasPerm = await hasOriginPermission(session.targetOrigin, this.permissionsApi);
    } catch {
      hasPerm = false;
    }

    if (hasPerm) {
      if (this.hasScriptingCapability()) {
        try {
          await registerDynamicContentScripts(session.targetOrigin, { scriptingApi: this.scriptingApi });
        } catch (err) {
          console.warn('[PairingCoordinator] Dynamic script registration warning on restore:', err);
        }
      }
    }

    const currentState = this.fsm.getState();

    // Case 1: Fresh startup from UNPAIRED
    if (currentState === 'UNPAIRED') {
      this.fsm.transition('PAIRING', { reason: 'Restoring connection from storage' });
      this.fsm.transition('PAIRED_NO_PERMISSION', {
        reason: 'Restored paired session from storage',
        connectionId: session.connectionId,
        installationId: session.installationId,
        targetOrigin: session.targetOrigin,
        metadata: { clinicId: session.clinicId, expiresAt: session.expiresAt },
      });

      if (hasPerm && this.fsm.canTransition('PROBING')) {
        this.fsm.transition('PROBING', {
          reason: 'Restored session with active host permission',
          connectionId: session.connectionId,
          installationId: session.installationId,
          targetOrigin: session.targetOrigin,
        });
      }
    } else if (currentState === 'PAIRED_NO_PERMISSION' && hasPerm) {
      // Case 2: Permission was granted
      if (this.fsm.canTransition('PROBING')) {
        this.fsm.transition('PROBING', {
          reason: 'Verified host permission is active',
          connectionId: session.connectionId,
          installationId: session.installationId,
          targetOrigin: session.targetOrigin,
        });
      }
    } else if ((currentState === 'PROBING' || currentState === 'ACTIVE') && !hasPerm) {
      // Case 3: Permission was revoked externally
      if (this.fsm.canTransition('PAIRED_NO_PERMISSION')) {
        this.fsm.transition('PAIRED_NO_PERMISSION', {
          reason: 'Host permission was revoked',
          connectionId: session.connectionId,
          installationId: session.installationId,
          targetOrigin: session.targetOrigin,
        });
      }
    }

    return this.fsm.getRecord();
  }
}
