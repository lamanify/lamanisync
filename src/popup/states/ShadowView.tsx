export interface ShadowViewProps {
  clinicName?: string;
  clinicId?: string;
  targetOrigin?: string;
  syncProgress?: number; // 0 - 100
  lastReadAt?: string | null;
  isLoading?: boolean;
  onUnpair: () => void;
}

export function ShadowView({
  clinicName = 'Clinic Sync Target',
  clinicId,
  targetOrigin,
  syncProgress = 0,
  lastReadAt,
  isLoading = false,
  onUnpair,
}: ShadowViewProps) {
  const formattedReadTime = lastReadAt ? new Date(lastReadAt).toLocaleTimeString() : 'Pending first read';

  return (
    <div className="state-card" data-testid="shadow-view">
      <div className="card-header">
        <h2 className="card-title" data-testid="clinic-name">
          {clinicName}
        </h2>
        <span className="badge badge-purple" data-testid="shadow-badge">
          SHADOW MODE
        </span>
      </div>

      <div className="info-block">
        <span className="info-label">Connected Origin:</span>
        <code className="origin-badge" data-testid="target-origin">
          {targetOrigin || 'No origin configured'}
        </code>
      </div>

      {clinicId && (
        <div className="info-block">
          <span className="info-label">Clinic ID:</span>
          <span className="info-value" data-testid="clinic-id">
            {clinicId}
          </span>
        </div>
      )}

      <div className="sync-section">
        <div className="sync-header">
          <span className="info-label">Historical Sync Progress:</span>
          <span className="sync-percentage" data-testid="sync-progress">
            {syncProgress}%
          </span>
        </div>
        <div
          className="progress-bar-container"
          role="progressbar"
          aria-valuenow={syncProgress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="progress-bar-fill"
            style={{ width: `${Math.min(100, Math.max(0, syncProgress))}%` }}
          />
        </div>
      </div>

      <div className="freshness-grid">
        <div className="freshness-item">
          <span className="info-label">Last Observed Read:</span>
          <span className="freshness-time" data-testid="last-read-timestamp">
            {formattedReadTime}
          </span>
        </div>
      </div>

      <p className="card-desc shadow-notice">
        Read-only observation mode. Writes are strictly simulated or disabled during shadow validation.
      </p>

      <div className="card-actions">
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
