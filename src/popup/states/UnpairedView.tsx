import React, { useState } from 'react';

export interface UnpairedViewProps {
  isLoading?: boolean;
  errorMessage?: string | null;
  onPair: (code: string) => Promise<void> | void;
}

export function UnpairedView({
  isLoading = false,
  errorMessage = null,
  onPair,
}: UnpairedViewProps) {
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const displayError = errorMessage || localError;

  const handleSubmit = async (e: React.FormEvent) => {
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

  return (
    <div className="state-card" data-testid="unpaired-view">
      <div className="card-header">
        <h2 className="card-title">Connect Clinic Device</h2>
        <span className="badge badge-neutral" data-testid="unpaired-badge">
          UNPAIRED
        </span>
      </div>

      <p className="card-desc">
        Securely bridge your clinic CMS tab with LamaniHub without storing passwords or transmitting unverified PHI.
      </p>

      <form onSubmit={handleSubmit} className="card-form">
        <label htmlFor="pairing-code" className="form-label">
          LamaniHub Pairing Code:
        </label>
        <input
          id="pairing-code"
          type="text"
          className="form-input code-input"
          data-testid="pairing-code-input"
          placeholder="e.g. PAIR-1234"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          disabled={isLoading}
          autoFocus
          aria-required="true"
        />

        {displayError && (
          <div
            className="error-banner"
            role="alert"
            data-testid="pairing-error"
          >
            {displayError}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          data-testid="pair-button"
          disabled={isLoading || !code.trim()}
        >
          {isLoading ? 'Pairing...' : 'Pair Device'}
        </button>
      </form>
    </div>
  );
}
