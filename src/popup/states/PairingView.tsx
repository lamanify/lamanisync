import React, { useState } from 'react';

export interface PairingViewProps {
  connectionState: string;
  targetOrigin?: string;
  clinicId?: string;
  isLoading?: boolean;
  errorMessage?: string | null;
  onPair: (pairingCode: string) => Promise<void> | void;
  onGrantPermission: () => Promise<void> | void;
  onUnpair: () => Promise<void> | void;
}

export function PairingView({
  connectionState,
  targetOrigin,
  clinicId,
  isLoading = false,
  errorMessage = null,
  onPair,
  onGrantPermission,
  onUnpair,
}: PairingViewProps) {
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const displayError = errorMessage || localError;

  const handlePairSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const clean = code.trim().toUpperCase();
    if (!clean) {
      setLocalError('Please enter a valid pairing code');
      return;
    }
    try {
      await onPair(clean);
    } catch (err) {
      setLocalError((err as Error).message || 'Pairing failed');
    }
  };

  // State 1: PAIRED_NO_PERMISSION - Requires explicit user click to request exact host permission
  if (connectionState === 'PAIRED_NO_PERMISSION') {
    return (
      <div className="pairing-card" data-testid="paired-no-permission-view">
        <div className="pairing-section">
          <span className="pairing-label">Pairing Status:</span>
          <span className="pairing-status-highlight">Awaiting CMS Permission</span>
        </div>

        {targetOrigin && (
          <div className="pairing-section">
            <span className="pairing-label">Target CMS Origin:</span>
            <code className="pairing-origin" data-testid="target-origin">
              {targetOrigin}
            </code>
          </div>
        )}

        {clinicId && (
          <div className="pairing-section">
            <span className="pairing-label">Clinic ID:</span>
            <span className="pairing-value">{clinicId}</span>
          </div>
        )}

        <p className="pairing-instruction">
          Click below to grant host access to your exact clinic CMS origin. Broad permissions are never requested.
        </p>

        {displayError && (
          <div className="pairing-error-banner" data-testid="pairing-error">
            {displayError}
          </div>
        )}

        <div className="pairing-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="grant-permission-button"
            onClick={onGrantPermission}
            disabled={isLoading}
          >
            {isLoading ? 'Requesting...' : 'Grant CMS Access'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="unpair-button"
            onClick={onUnpair}
            disabled={isLoading}
          >
            Unpair
          </button>
        </div>
      </div>
    );
  }

  // State 2: PROBING / ACTIVE - Paired & Permission Granted
  if (connectionState === 'PROBING' || connectionState === 'ACTIVE' || connectionState === 'SHADOW') {
    return (
      <div className="pairing-card" data-testid="connected-view">
        <div className="pairing-section">
          <span className="pairing-label">CMS Access:</span>
          <span className="pairing-status-active">Granted &amp; Active</span>
        </div>

        {targetOrigin && (
          <div className="pairing-section">
            <span className="pairing-label">Connected Origin:</span>
            <code className="pairing-origin" data-testid="target-origin">
              {targetOrigin}
            </code>
          </div>
        )}

        <p className="pairing-instruction">
          Bridge is active and monitoring clinic session synchronization.
        </p>

        <div className="pairing-actions">
          <button
            type="button"
            className="btn btn-danger"
            data-testid="unpair-button"
            onClick={onUnpair}
            disabled={isLoading}
          >
            {isLoading ? 'Unpairing...' : 'Unpair Device'}
          </button>
        </div>
      </div>
    );
  }

  // State 3: UNPAIRED / PAIRING - Initial pairing form
  return (
    <div className="pairing-card" data-testid="unpaired-view">
      <form onSubmit={handlePairSubmit} className="pairing-form">
        <label htmlFor="pairing-code" className="pairing-label">
          Enter LamaniHub Pairing Code:
        </label>
        <input
          id="pairing-code"
          type="text"
          className="pairing-input"
          data-testid="pairing-code-input"
          placeholder="e.g. PAIR-1234"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          disabled={isLoading}
          autoFocus
        />

        {displayError && (
          <div className="pairing-error-banner" data-testid="pairing-error">
            {displayError}
          </div>
        )}

        <div className="pairing-actions">
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="pair-button"
            disabled={isLoading || !code.trim()}
          >
            {isLoading ? 'Pairing...' : 'Pair Device'}
          </button>
        </div>
      </form>
    </div>
  );
}
