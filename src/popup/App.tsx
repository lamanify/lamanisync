import { useState } from 'react';
import './App.css';
import { useConnectionState } from './hooks/useConnectionState.js';
import { UnpairedView } from './states/UnpairedView.js';
import { PermissionPromptView } from './states/PermissionPromptView.js';
import { ProbingView } from './states/ProbingView.js';
import { ShadowView } from './states/ShadowView.js';
import { ActiveView } from './states/ActiveView.js';
import { ReauthView } from './states/ReauthView.js';
import { DegradedView } from './states/DegradedView.js';
import { PausedView } from './states/PausedView.js';
import { RevokedView } from './states/RevokedView.js';
import { DiagnosticsModal } from './components/DiagnosticsModal.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';

export function App() {
  const {
    connectionState,
    extensionVersion,
    adapterVersion,
    clinicId,
    clinicName,
    targetOrigin,
    isLoading,
    errorMessage,
    lastReadAt,
    lastWriteAt,
    syncProgress,
    pauseReason,
    errorSummary,
    probingSteps,
    pair,
    grantPermission,
    unpair,
    retry,
    openCmsTab,
    clearLocalState,
    refreshState,
    getDiagnosticBundle,
  } = useConnectionState();

  const [isDiagOpen, setIsDiagOpen] = useState(false);
  const [isUnpairConfirmOpen, setIsUnpairConfirmOpen] = useState(false);

  const formatStatus = (state: string) => {
    switch (state) {
      case 'PAIRED_NO_PERMISSION':
        return 'Paired (Permission Needed)';
      case 'PROBING':
        return 'Connected';
      case 'SHADOW':
        return 'Shadow Mode';
      case 'ACTIVE':
        return 'Connected';
      case 'REAUTH_REQUIRED':
        return 'Reauth Required';
      case 'DEGRADED':
        return 'Degraded';
      case 'PAUSED':
        return 'Paused';
      case 'REVOKED':
        return 'Revoked';
      case 'PAIRING':
        return 'Pairing...';
      default:
        return 'Unpaired';
    }
  };

  const renderStateView = () => {
    switch (connectionState) {
      case 'PAIRING':
        return <UnpairedView isLoading={true} errorMessage={errorMessage} onPair={pair} />;
      case 'PAIRED_NO_PERMISSION':
        return (
          <PermissionPromptView
            targetOrigin={targetOrigin}
            clinicId={clinicId}
            isLoading={isLoading}
            errorMessage={errorMessage}
            onGrantPermission={grantPermission}
            onUnpair={() => setIsUnpairConfirmOpen(true)}
          />
        );
      case 'PROBING':
        return (
          <ProbingView
            targetOrigin={targetOrigin}
            isLoading={isLoading}
            errorMessage={errorMessage}
            stepStatus={probingSteps}
            onRetryProbe={retry}
            onUnpair={() => setIsUnpairConfirmOpen(true)}
          />
        );
      case 'SHADOW':
        return (
          <ShadowView
            clinicName={clinicName}
            clinicId={clinicId}
            targetOrigin={targetOrigin}
            syncProgress={syncProgress}
            lastReadAt={lastReadAt}
            isLoading={isLoading}
            onUnpair={() => setIsUnpairConfirmOpen(true)}
          />
        );
      case 'ACTIVE':
        return (
          <ActiveView
            clinicName={clinicName}
            clinicId={clinicId}
            targetOrigin={targetOrigin}
            adapterVersion={adapterVersion}
            lastReadAt={lastReadAt}
            lastWriteAt={lastWriteAt}
            isLoading={isLoading}
            onOpenDiagnostics={() => setIsDiagOpen(true)}
            onUnpair={() => setIsUnpairConfirmOpen(true)}
          />
        );
      case 'REAUTH_REQUIRED':
        return (
          <ReauthView
            targetOrigin={targetOrigin}
            isLoading={isLoading}
            onOpenCmsTab={openCmsTab}
            onRetry={retry}
            onUnpair={() => setIsUnpairConfirmOpen(true)}
          />
        );
      case 'DEGRADED':
        return (
          <DegradedView
            errorSummary={errorSummary || errorMessage}
            targetOrigin={targetOrigin}
            isLoading={isLoading}
            onRetry={retry}
            onOpenDiagnostics={() => setIsDiagOpen(true)}
            onUnpair={() => setIsUnpairConfirmOpen(true)}
          />
        );
      case 'PAUSED':
        return (
          <PausedView
            pauseReason={pauseReason}
            targetOrigin={targetOrigin}
            isLoading={isLoading}
            onRefresh={refreshState}
            onUnpair={() => setIsUnpairConfirmOpen(true)}
          />
        );
      case 'REVOKED':
        return (
          <RevokedView
            isLoading={isLoading}
            onClearState={() => setIsUnpairConfirmOpen(true)}
          />
        );
      case 'UNPAIRED':
      default:
        return <UnpairedView isLoading={isLoading} errorMessage={errorMessage} onPair={pair} />;
    }
  };

  return (
    <div className="popup-container">
      <header className="popup-header">
        <div className="header-left">
          <h1 className="popup-title">LamaniSync Dev</h1>
          <span className="popup-version" data-testid="extension-version">
            v{extensionVersion}
          </span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn-header-action"
            data-testid="header-diagnostics-button"
            onClick={() => setIsDiagOpen(true)}
            aria-label="Open Diagnostics Modal"
          >
            Diagnostics
          </button>
        </div>
      </header>

      <div className="status-badge" data-testid="connection-status" aria-live="polite">
        <span
          className={`status-indicator ${
            connectionState === 'ACTIVE'
              ? 'status-indicator-active'
              : connectionState === 'SHADOW'
              ? 'status-indicator-purple'
              : connectionState === 'PROBING'
              ? 'status-indicator-info'
              : connectionState === 'PAIRED_NO_PERMISSION' || connectionState === 'REAUTH_REQUIRED'
              ? 'status-indicator-warning'
              : connectionState === 'DEGRADED' || connectionState === 'REVOKED'
              ? 'status-indicator-danger'
              : ''
          }`}
        />
        <span>{formatStatus(connectionState)}</span>
      </div>

      {renderStateView()}

      <DiagnosticsModal
        isOpen={isDiagOpen}
        onClose={() => setIsDiagOpen(false)}
        bundle={getDiagnosticBundle()}
      />

      <ConfirmDialog
        isOpen={isUnpairConfirmOpen}
        title={connectionState === 'REVOKED' ? 'Clear Local State' : 'Confirm Device Unpair'}
        message={
          connectionState === 'REVOKED'
            ? 'This will purge local keys and sessions from this browser so you can connect a new device.'
            : 'Are you sure you want to unpair this device? Data synchronization will cease immediately.'
        }
        confirmLabel={connectionState === 'REVOKED' ? 'Clear Local State' : 'Unpair Device'}
        cancelLabel="Cancel"
        isLoading={isLoading}
        onConfirm={async () => {
          if (connectionState === 'REVOKED') {
            await clearLocalState();
          } else {
            await unpair();
          }
          setIsUnpairConfirmOpen(false);
        }}
        onCancel={() => setIsUnpairConfirmOpen(false)}
        testId="unpair-confirm-dialog"
      />
    </div>
  );
}
