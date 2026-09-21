export interface ActiveViewProps {
  clinicName?: string;
  clinicId?: string;
  targetOrigin?: string;
  adapterVersion?: string;
  lastReadAt?: string | null;
  lastWriteAt?: string | null;
  isLoading?: boolean;
  onOpenDiagnostics: () => void;
  onUnpair: () => void;
}

export function ActiveView({
  clinicName = 'Clinic Active Node',
  clinicId,
  targetOrigin,
  adapterVersion = '1.0.0',
  lastReadAt,
  lastWriteAt,
  isLoading = false,
  onOpenDiagnostics,
  onUnpair,
}: ActiveViewProps) {
  const formattedRead = lastReadAt ? new Date(lastReadAt).toLocaleTimeString() : 'Awaiting read';
  const formattedWrite = lastWriteAt ? new Date(lastWriteAt).toLocaleTimeString() : 'No writes queued';

  return (
    <div className="state-card" data-testid="active-view">
      <div className="card-header">
        <h2 className="card-title" data-testid="clinic-name">
          {clinicName}
        </h2>
        <span className="badge badge-success" data-testid="active-badge">
          ACTIVE • Operational
        </span>
      </div>

      <div className="info-block">
        <span className="info-label">Connected CMS Origin:</span>
        <code className="origin-badge" data-testid="target-origin">
          {targetOrigin || 'No origin configured'}
        </code>
      </div>

      <div className="info-row">
        {clinicId && (
          <div className="info-block-half">
            <span className="info-label">Clinic ID:</span>
            <span className="info-value" data-testid="clinic-id">
              {clinicId}
            </span>
          </div>
        )}
        <div className="info-block-half">
          <span className="info-label">Adapter Version:</span>
          <span className="info-value" data-testid="adapter-version">
            v{adapterVersion}
          </span>
        </div>
      </div>

      <div className="freshness-grid">
        <div className="freshness-item">
          <span className="info-label">Last Read Freshness:</span>
          <span className="freshness-time" data-testid="last-read-timestamp">
            {formattedRead}
          </span>
        </div>
        <div className="freshness-item">
          <span className="info-label">Last Write Verified:</span>
          <span className="freshness-time" data-testid="last-write-timestamp">
            {formattedWrite}
          </span>
        </div>
      </div>

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="open-diagnostics-button"
          onClick={onOpenDiagnostics}
        >
          Diagnostics
        </button>
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
