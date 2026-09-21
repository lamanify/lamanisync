export interface PausedViewProps {
  pauseReason?: string | null;
  targetOrigin?: string;
  isLoading?: boolean;
  onRefresh: () => Promise<void> | void;
  onUnpair: () => void;
}

export function PausedView({
  pauseReason = 'Synchronization administratively paused by LamaniHub',
  targetOrigin,
  isLoading = false,
  onRefresh,
  onUnpair,
}: PausedViewProps) {
  return (
    <div className="state-card" data-testid="paused-view">
      <div className="card-header">
        <h2 className="card-title">Sync Paused</h2>
        <span className="badge badge-neutral" data-testid="paused-badge">
          PAUSED
        </span>
      </div>

      {targetOrigin && (
        <div className="info-block">
          <span className="info-label">Clinic CMS Origin:</span>
          <code className="origin-badge" data-testid="target-origin">
            {targetOrigin}
          </code>
        </div>
      )}

      <div className="alert-box alert-slate">
        <p className="alert-title">Kill-Switch / Maintenance Mode</p>
        <p className="card-desc" data-testid="pause-reason">
          {pauseReason}
        </p>
      </div>

      <p className="card-desc">
        Data synchronization is suspended. The extension will automatically resume when the maintenance window concludes.
      </p>

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="retry-button"
          onClick={onRefresh}
          disabled={isLoading}
        >
          {isLoading ? 'Checking...' : 'Check Status'}
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
