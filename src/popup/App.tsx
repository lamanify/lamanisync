import { useEffect, useState } from 'react';
import './App.css';
import { PairingView } from './states/PairingView.js';
import {
  SESSION_STORAGE_KEY,
  ConnectionSessionSchema,
  type ConnectionSession,
} from '../background/pairing.js';
import {
  requestOriginPermission,
  hasOriginPermission,
  removeOriginPermission,
} from '../background/permissions.js';
import { SyncApiClient } from '../background/api-client.js';
import { getOrCreateDeviceKey, purgeDeviceKey } from '../storage/device-key.js';

export function App() {
  const [version, setVersion] = useState<string>('');
  const [connectionState, setConnectionState] = useState<string>('UNPAIRED');
  const [session, setSession] = useState<ConnectionSession | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const manifest = chrome.runtime.getManifest();
      setVersion(manifest.version || 'unknown');
    } else {
      setVersion('dev');
    }

    loadInitialSession();
  }, []);

  const loadInitialSession = async () => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' }, async (response) => {
          if (chrome.runtime.lastError || !response?.record) {
            await loadFromStorageFallback();
            return;
          }
          const record = response.record;
          setConnectionState(record.state);
          if (record.state === 'UNPAIRED') {
            setSession(null);
          } else {
            await loadFromStorageFallback();
          }
        });
      } else {
        await loadFromStorageFallback();
      }
    } catch {
      await loadFromStorageFallback();
    }
  };

  const loadFromStorageFallback = async () => {
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
  };

  const handlePair = async (code: string) => {
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
        setSession({
          installationId: res.installationId,
          connectionId: res.connectionId,
          clinicId: res.clinicId,
          sessionToken: res.sessionToken,
          expiresAt: res.expiresAt,
          targetOrigin: res.targetOrigin,
          pairedAt: new Date().toISOString(),
        });
        setConnectionState('PAIRED_NO_PERMISSION');
      } else {
        // Fallback for standalone/mocked contexts without chrome.runtime.sendMessage
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
    } finally {
      setIsLoading(false);
    }
  };

  const handleGrantPermission = async () => {
    if (!session?.targetOrigin) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      // Must be triggered by explicit user gesture in the popup
      const granted = await requestOriginPermission(session.targetOrigin, session.targetOrigin);
      if (granted) {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          await new Promise<void>((resolve) => {
            chrome.runtime.sendMessage(
              { type: 'GRANT_PERMISSION_RESULT', granted: true, targetOrigin: session.targetOrigin },
              () => resolve()
            );
          });
        }
        setConnectionState('PROBING');
      } else {
        setErrorMessage('Permission was declined by the user');
      }
    } catch (err) {
      setErrorMessage((err as Error).message || 'Permission request failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnpair = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (session?.targetOrigin) {
        await removeOriginPermission(session.targetOrigin).catch(() => {});
      }

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        await new Promise<void>((resolve) => {
          chrome.runtime.sendMessage({ type: 'UNPAIR' }, () => resolve());
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
      setConnectionState('UNPAIRED');
    } catch (err) {
      setErrorMessage((err as Error).message || 'Unpair failed');
    } finally {
      setIsLoading(false);
    }
  };

  const formatStatus = (state: string) => {
    switch (state) {
      case 'PAIRED_NO_PERMISSION':
        return 'Paired (Permission Needed)';
      case 'PROBING':
      case 'ACTIVE':
        return 'Connected';
      case 'PAIRING':
        return 'Pairing...';
      default:
        return 'Unpaired';
    }
  };

  return (
    <div className="popup-container">
      <header className="popup-header">
        <h1 className="popup-title">LamaniSync Dev</h1>
        <span className="popup-version" data-testid="extension-version">
          v{version}
        </span>
      </header>

      <div className="status-badge" data-testid="connection-status">
        <span
          className={`status-indicator ${
            connectionState === 'PROBING' || connectionState === 'ACTIVE'
              ? 'status-indicator-active'
              : connectionState === 'PAIRED_NO_PERMISSION'
              ? 'status-indicator-warning'
              : ''
          }`}
        ></span>
        <span>{formatStatus(connectionState)}</span>
      </div>

      <PairingView
        connectionState={connectionState}
        targetOrigin={session?.targetOrigin}
        clinicId={session?.clinicId}
        isLoading={isLoading}
        errorMessage={errorMessage}
        onPair={handlePair}
        onGrantPermission={handleGrantPermission}
        onUnpair={handleUnpair}
      />
    </div>
  );
}
