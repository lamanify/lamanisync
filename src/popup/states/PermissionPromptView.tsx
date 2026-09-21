export interface PermissionPromptViewProps {
  targetOrigin?: string;
  clinicId?: string;
  isLoading?: boolean;
  errorMessage?: string | null;
  onGrantPermission: () => Promise<void> | void;
  onUnpair: () => void;
}

export function PermissionPromptView({
  targetOrigin,
  clinicId,
  isLoading = false,
  errorMessage = null,
  onGrantPermission,
  onUnpair,
}: PermissionPromptViewProps) {
  return (
    <div className="state-card" data-testid="paired-no-permission-view">
      <div className="card-header">
        <h2 className="card-title">CMS Access Required</h2>
        <span className="badge badge-warning" data-testid="permission-needed-badge">
          PERMISSION NEEDED
        </span>
      </div>

      <div className="info-block">
        <span className="info-label">Target Clinic CMS:</span>
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

      <p className="card-desc">
        LamaniSync needs browser permission to interact with your clinic CMS tab. In accordance with strict security policies, permission is requested <strong>exclusively</strong> for this exact origin.
      </p>

      {errorMessage && (
        <div className="error-banner" role="alert" data-testid="permission-error">
          {errorMessage}
        </div>
      )}

      <div className="card-actions">
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
          Unpair Device
        </button>
      </div>
    </div>
  );
}
