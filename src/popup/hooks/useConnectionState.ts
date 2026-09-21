import { useEffect, useState, useCallback } from 'react';
import type { ConnectionState, ConnectionStateRecord } from '../../core/contracts/connection.js';
import {
  SESSION_STORAGE_KEY,
  ConnectionSessionSchema,
  type ConnectionSession,
} from '../../background/pairing.js';
import {
  requestOriginPermission,
  hasOriginPermission,
  removeOriginPermission,
} from '../../background/permissions.js';
import { SyncApiClient } from '../../background/api-client.js';
import { getOrCreateDeviceKey, purgeDeviceKey } from '../../storage/device-key.js';
import {
  formatDiagnosticBundle,
  type FormattedDiagnosticBundle,
} from '../../core/redaction.js';
import type { StepStatus } from '../states/ProbingView.js';

export interface UseConnectionStateReturn {
  connectionState: ConnectionState;
  record: ConnectionStateRecord | null;
  session: ConnectionSession | null;
  extensionVersion: string;
  adapterVersion: string;
  clinicId?: string;
  clinicName?: string;
  targetOrigin?: string;
  isLoading: boolean;
  errorMessage: string | null;
  lastReadAt: string | null;
  lastWriteAt: string | null;
  syncProgress: number;
  pauseReason: string | null;
  errorSummary: string | null;
  correlationId: string | null;
  probingSteps: {
    versionCheck: StepStatus;
    tenantValidation: StepStatus;
    capabilityProbe: StepStatus;
  };
  pair: (code: string) => Promise<void>;
  grantPermission: () => Promise<void>;
  unpair: (reason?: string) => Promise<void>;
  retry: () => Promise<void>;
  openCmsTab: () => Promise<void>;
  clearLocalState: () => Promise<void>;
  refreshState: () => Promise<void>;
  getDiagnosticBundle: () => FormattedDiagnosticBundle;
}

export function useConnectionState(): UseConnectionStateReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('UNPAIRED');
  const [record, setRecord] = useState<ConnectionStateRecord | null>(null);
  const [session, setSession] = useState<ConnectionSession | null>(null);
  const [extensionVersion, setExtensionVersion] = useState<string>('0.1.0');
  const [adapterVersion, setAdapterVersion] = useState<string>('1.0.0');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [lastWriteAt, setLastWriteAt] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<number>(0);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [errorSummary, setErrorSummary] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [probingSteps, setProbingSteps] = useState<{
    versionCheck: StepStatus;
    tenantValidation: StepStatus;
    capabilityProbe: StepStatus;
  }>({
    versionCheck: 'completed',
    tenantValidation: 'in_progress',
    capabilityProbe: 'pending',
  });

  const applyRecordMetadata = useCallback((rec: ConnectionStateRecord) => {
    if (rec.metadata) {
      const meta = rec.metadata as Record<string, unknown>;
      if (typeof meta.lastReadAt === 'string') setLastReadAt(meta.lastReadAt);
      if (typeof meta.lastWriteAt === 'string') setLastWriteAt(meta.lastWriteAt);
      else if (typeof meta.verifiedAt === 'string') setLastWriteAt(meta.verifiedAt);
      if (typeof meta.syncProgress === 'number') setSyncProgress(meta.syncProgress);
      if (typeof meta.pauseReason === 'string') setPauseReason(meta.pauseReason);
      if (typeof meta.errorSummary === 'string') setErrorSummary(meta.errorSummary);
      if (typeof meta.correlationId === 'string') setCorrelationId(meta.correlationId);
      if (typeof meta.adapterVersion === 'string') setAdapterVersion(meta.adapterVersion);
    }
    if (rec.reason && rec.state === 'PAUSED') {
      setPauseReason(rec.reason);
    }
    if (rec.reason && rec.state === 'DEGRADED') {
      setErrorSummary(rec.reason);
    }
  }, []);

  const loadFromStorageFallback = useCallback(async () => {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
        const raw = stored[SESSION_STORAGE_KEY];
        if (raw) {
          const parsed = ConnectionSessionSchema.safeParse(raw);
          if (parsed.success) {
            const sess = parsed.data;
            setSession(sess);

            const hasPerm = await hasOriginPermission(sess.targetOrigin).catch(() => false);
            if (hasPerm) {
              setConnectionState('PROBING');
            } else {
              setConnectionState('PAIRED_NO_PERMISSION');
            }
            return;
          }
        }
      }
      setSession(null);
      setConnectionState('UNPAIRED');
    } catch {
      setSession(null);
      setConnectionState('UNPAIRED');
    }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }, async (response) => {
          if (chrome.runtime.lastError || !response?.record) {
            await loadFromStorageFallback();
            return;
          }
          const rec = response.record as ConnectionStateRecord;
          setRecord(rec);
          setConnectionState(rec.state);
          applyRecordMetadata(rec);

          if (rec.state === 'UNPAIRED') {
            setSession(null);
          } else {
            // Load full session from storage
            if (typeof chrome !== 'undefined' && chrome.storage?.local) {
              const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
              const raw = stored[SESSION_STORAGE_KEY];
              if (raw) {
                const parsed = ConnectionSessionSchema.safeParse(raw);
                if (parsed.success) {
                  setSession(parsed.data);
                }
              }
            }
          }
        });
      } else {
        await loadFromStorageFallback();
      }
    } catch {
      await loadFromStorageFallback();
    }
  }, [applyRecordMetadata, loadFromStorageFallback]);

  // Initial load and subscriptions
  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const manifest = chrome.runtime.getManifest();
      setExtensionVersion(manifest.version || '0.1.0');
    }

    refreshState();

    // Subscribe to chrome.storage changes
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName === 'local') {
        if (changes[SESSION_STORAGE_KEY]) {
          refreshState();
        }
      }
    };

    // Subscribe to runtime messages (e.g. state change broadcasts)
    const handleRuntimeMessage = (
      message: { type?: string; record?: ConnectionStateRecord; error?: string }
    ) => {
      if (message?.type === 'CONNECTION_STATE_CHANGED' && message.record) {
        setRecord(message.record);
        setConnectionState(message.record.state);
        applyRecordMetadata(message.record);
      }
    };

    if (typeof chrome !== 'undefined') {
      if (chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener(handleStorageChange);
      }
      if (chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener(handleRuntimeMessage);
      }
    }

    return () => {
      if (typeof chrome !== 'undefined') {
        if (chrome.storage?.onChanged) {
          chrome.storage.onChanged.removeListener(handleStorageChange);
        }
        if (chrome.runtime?.onMessage) {
          chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
        }
      }
    };
  }, [refreshState, applyRecordMetadata]);

  const pair = async (code: string) => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const response = await new Promise<{
          success: boolean;
          result?: {
            installationId: string;
            connectionId: string;
            clinicId: string;
            sessionToken: string;
            expiresAt: string;
            targetOrigin: string;
          };
          record?: ConnectionStateRecord;
          error?: string;
        }>((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'PAIR', pairingCode: code, deviceName: 'Popup Profile' },
            (res) => {
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(res || { success: false, error: 'No response from background' });
              }
            }
          );
        });

        if (!response.success || !response.result) {
          throw new Error(response.error || 'Pairing failed');
        }

        const res = response.result;
        const newSession: ConnectionSession = {
          installationId: res.installationId,
          connectionId: res.connectionId,
          clinicId: res.clinicId,
          sessionToken: res.sessionToken,
          expiresAt: res.expiresAt,
          targetOrigin: res.targetOrigin,
          pairedAt: new Date().toISOString(),
        };

        setSession(newSession);
        if (response.record) {
          setRecord(response.record);
          setConnectionState(response.record.state);
        } else {
          setConnectionState('PAIRED_NO_PERMISSION');
        }
      } else {
        const { publicKeySpki } = await getOrCreateDeviceKey();
        const client = new SyncApiClient();
        const result = await client.pair(code, publicKeySpki, 'Popup Web Profile');

        const newSession: ConnectionSession = {
          installationId: result.installationId,
          connectionId: result.connectionId,
          clinicId: result.clinicId,
          sessionToken: result.sessionToken,
          expiresAt: result.expiresAt,
          targetOrigin: result.targetOrigin,
          pairedAt: new Date().toISOString(),
        };

        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: newSession });
        }

        setSession(newSession);
        setConnectionState('PAIRED_NO_PERMISSION');
      }
    } catch (err) {
      setErrorMessage((err as Error).message || 'Pairing failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const grantPermission = async () => {
    if (!session?.targetOrigin) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const granted = await requestOriginPermission(session.targetOrigin, session.targetOrigin);
      if (granted) {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const res = await new Promise<{
            success?: boolean;
            error?: string;
            record?: ConnectionStateRecord;
          }>((resolve) => {
            chrome.runtime.sendMessage(
              { type: 'GRANT_PERMISSION_RESULT', granted: true, targetOrigin: session.targetOrigin },
              (r) => {
                if (chrome.runtime.lastError) {
                  resolve({ success: false, error: chrome.runtime.lastError.message });
                } else {
                  resolve(r || { success: true });
                }
              }
            );
          });
          if (res?.record) {
            setRecord(res.record);
            setConnectionState(res.record.state);
            applyRecordMetadata(res.record);
          } else {
            setConnectionState('PROBING');
          }
        } else {
          setConnectionState('PROBING');
        }
      } else {
        setErrorMessage('Host permission was declined by the user');
      }
    } catch (err) {
      setErrorMessage((err as Error).message || 'Permission request failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const unpair = async (reason: string = 'User initiated unpair') => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (session?.targetOrigin) {
        await removeOriginPermission(session.targetOrigin).catch(() => {});
      }

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        await new Promise<void>((resolve) => {
          chrome.runtime.sendMessage({ type: 'UNPAIR', reason }, () => resolve());
        });
      } else {
        if (session?.installationId) {
          const client = new SyncApiClient();
          await client.revoke(session.installationId).catch(() => {});
        }
        await purgeDeviceKey().catch(() => {});
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          await chrome.storage.local.remove(SESSION_STORAGE_KEY);
        }
      }

      setSession(null);
      setRecord(null);
      setConnectionState('UNPAIRED');
    } catch (err) {
      setErrorMessage((err as Error).message || 'Unpair failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const clearLocalState = async () => {
    setIsLoading(true);
    try {
      await purgeDeviceKey().catch(() => {});
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.remove(SESSION_STORAGE_KEY);
      }
      setSession(null);
      setRecord(null);
      setConnectionState('UNPAIRED');
    } finally {
      setIsLoading(false);
    }
  };

  const retry = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        if (
          connectionState === 'PROBING' ||
          connectionState === 'DEGRADED' ||
          connectionState === 'REAUTH_REQUIRED'
        ) {
          if (connectionState === 'PROBING') {
            setProbingSteps({
              versionCheck: 'in_progress',
              tenantValidation: 'pending',
              capabilityProbe: 'pending',
            });
          }
          const res = await new Promise<{
            success: boolean;
            error?: string;
            record?: ConnectionStateRecord;
          }>((resolve) => {
            chrome.runtime.sendMessage({ type: 'RUN_PROBE' }, (r) => {
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(r || { success: false, error: 'Probe response timeout' });
              }
            });
          });
          if (res.success) {
            if (connectionState === 'PROBING') {
              setProbingSteps({
                versionCheck: 'completed',
                tenantValidation: 'completed',
                capabilityProbe: 'completed',
              });
            }
            if (res.record) {
              setRecord(res.record);
              setConnectionState(res.record.state);
              applyRecordMetadata(res.record);
            }
            await refreshState();
          } else {
            if (connectionState === 'PROBING') {
              setProbingSteps({
                versionCheck: 'completed',
                tenantValidation: 'failed',
                capabilityProbe: 'pending',
              });
            }
            setErrorMessage(res.error || 'Connection retry failed');
            await refreshState();
          }
        } else {
          await refreshState();
        }
      } else {
        await refreshState();
      }
    } catch (err) {
      setErrorMessage((err as Error).message || 'Retry failed');
    } finally {
      setIsLoading(false);
    }
  };

  const openCmsTab = async () => {
    const url = session?.targetOrigin || record?.targetOrigin;
    if (!url) return;

    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      try {
        const tabs = await chrome.tabs.query({});
        const existingTab = tabs.find(
          (t) => t.url && (t.url === url || t.url.startsWith(`${url}/`) || t.url.startsWith(url))
        );
        if (existingTab && existingTab.id !== undefined) {
          if (chrome.tabs.update) {
            await chrome.tabs.update(existingTab.id, { active: true });
          }
          if (existingTab.windowId !== undefined && chrome.windows?.update) {
            await chrome.windows.update(existingTab.windowId, { focused: true });
          }
          return;
        }
      } catch {
        // Fallback to create
      }
    }

    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      try {
        await chrome.tabs.create({ url });
        return;
      } catch {
        // Fallback
      }
    }
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const getDiagnosticBundle = useCallback((): FormattedDiagnosticBundle => {
    return formatDiagnosticBundle({
      installationId: session?.installationId || record?.installationId,
      connectionId: session?.connectionId || record?.connectionId,
      adapterVersion,
      extensionVersion,
      currentState: connectionState,
      correlationId,
      targetOrigin: session?.targetOrigin || record?.targetOrigin,
      lastReadAt,
      lastWriteAt,
      error: errorSummary || errorMessage,
      rawDetails: record?.metadata,
    });
  }, [
    session,
    record,
    adapterVersion,
    extensionVersion,
    connectionState,
    correlationId,
    lastReadAt,
    lastWriteAt,
    errorSummary,
    errorMessage,
  ]);

  return {
    connectionState,
    record,
    session,
    extensionVersion,
    adapterVersion,
    clinicId: session?.clinicId,
    clinicName: (record?.metadata?.clinicName as string) || (session?.clinicId ? `Clinic ${session.clinicId}` : undefined),
    targetOrigin: session?.targetOrigin || record?.targetOrigin,
    isLoading,
    errorMessage,
    lastReadAt,
    lastWriteAt,
    syncProgress,
    pauseReason,
    errorSummary,
    correlationId,
    probingSteps,
    pair,
    grantPermission,
    unpair,
    retry,
    openCmsTab,
    clearLocalState,
    refreshState,
    getDiagnosticBundle,
  };
}
