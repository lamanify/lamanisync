import { redactSensitiveString } from '../../core/redaction.js';

export interface DegradedViewProps {
  errorSummary?: string | null;
  targetOrigin?: string;
  isLoading?: boolean;
  onRetry: () => Promise<void> | void;
  onOpenDiagnostics: () => void;
  onUnpair: () => void;
}

export function DegradedView({
  errorSummary = 'Upstream sync error encountered',
  targetOrigin,
  isLoading = false,
  onRetry,
  onOpenDiagnostics,
  onUnpair,
}: DegradedViewProps) {
  const safeError = redactSensitiveString(errorSummary || 'An error interrupted synchronization');

  return (
    <div className="state-card" data-testid="degraded-view">
      <div className="card-header">
        <h2 className="card-title">Sync Degraded</h2>
        <span className="badge badge-danger" data-testid="degraded-badge">
          DEGRADED
        </span>
      </div>

      {targetOrigin && (
        <div className="info-block">
          <span className="info-label">Connected Origin:</span>
          <code className="origin-badge" data-testid="target-origin">
            {targetOrigin}
          </code>
        </div>
      )}

      <div className="alert-box alert-rose">
        <p className="alert-title">Operational Disruption</p>
        <p className="sanitized-error-text" data-testid="error-summary">
          {safeError}
        </p>
      </div>

      <p className="card-desc">
        Sync operations are temporarily degraded. Diagnostic logs have been sanitized of all patient data and credentials.
      </p>

      <div className="card-actions-stacked">
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="retry-button"
            onClick={onRetry}
            disabled={isLoading}
          >
            {isLoading ? 'Retrying...' : 'Retry Connection'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="view-diagnostics-button"
            onClick={onOpenDiagnostics}
          >
            Diagnostics
          </button>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="unpair-button"
          onClick={onUnpair}
          disabled={isLoading}
        >
          Unpair Device
        </button>
      </div>
    </div>
  );
}
