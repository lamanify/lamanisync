export interface ReauthViewProps {
  targetOrigin?: string;
  isLoading?: boolean;
  onOpenCmsTab: () => void;
  onRetry: () => Promise<void> | void;
  onUnpair: () => void;
}

export function ReauthView({
  targetOrigin,
  isLoading = false,
  onOpenCmsTab,
  onRetry,
  onUnpair,
}: ReauthViewProps) {
  return (
    <div className="state-card" data-testid="reauth-view">
      <div className="card-header">
        <h2 className="card-title">Authentication Expired</h2>
        <span className="badge badge-amber" data-testid="reauth-badge">
          REAUTH REQUIRED
        </span>
      </div>

      <div className="info-block">
        <span className="info-label">Clinic CMS Origin:</span>
        <code className="origin-badge" data-testid="target-origin">
          {targetOrigin || 'No origin configured'}
        </code>
      </div>

      <div className="alert-box alert-amber">
        <p className="alert-title">CMS Session Timed Out</p>
        <p className="card-desc">
          Your clinic CMS session is no longer authenticated. Please open your CMS tab and log in again so LamaniSync can resume synchronization.
        </p>
      </div>

      <div className="card-actions-stacked">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="open-cms-button"
          onClick={onOpenCmsTab}
        >
          Open CMS Login Tab
        </button>
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="retry-button"
            onClick={onRetry}
            disabled={isLoading}
          >
            {isLoading ? 'Checking...' : 'Check Connection'}
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
    </div>
  );
}
