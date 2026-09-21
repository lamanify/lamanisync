export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ProbingViewProps {
  targetOrigin?: string;
  isLoading?: boolean;
  errorMessage?: string | null;
  stepStatus?: {
    versionCheck?: StepStatus;
    tenantValidation?: StepStatus;
    capabilityProbe?: StepStatus;
  };
  onRetryProbe: () => Promise<void> | void;
  onUnpair: () => void;
}

export function ProbingView({
  targetOrigin,
  isLoading = false,
  errorMessage = null,
  stepStatus = {
    versionCheck: 'completed',
    tenantValidation: 'in_progress',
    capabilityProbe: 'pending',
  },
  onRetryProbe,
  onUnpair,
}: ProbingViewProps) {
  const renderStepIcon = (status: StepStatus = 'pending') => {
    switch (status) {
      case 'completed':
        return <span className="step-icon step-done">✓</span>;
      case 'in_progress':
        return <span className="step-icon step-running">●</span>;
      case 'failed':
        return <span className="step-icon step-failed">✕</span>;
      default:
        return <span className="step-icon step-pending">○</span>;
    }
  };

  return (
    <div className="state-card" data-testid="probing-view">
      <div className="card-header">
        <h2 className="card-title">Probing CMS Bridge</h2>
        <span className="badge badge-info" data-testid="probing-badge">
          PROBING
        </span>
      </div>

      <div className="info-block">
        <span className="info-label">Connected Origin:</span>
        <code className="origin-badge" data-testid="target-origin">
          {targetOrigin || 'No origin configured'}
        </code>
      </div>

      <p className="card-desc">
        Validating CMS adapter compatibility, tenant isolation, and read/write capabilities.
      </p>

      <ul className="probe-steps-list" aria-label="Probing verification steps">
        <li className="probe-step-item" data-testid="probe-step-version">
          {renderStepIcon(stepStatus.versionCheck)}
          <span className="probe-step-label">CMS Version &amp; Route Check</span>
        </li>
        <li className="probe-step-item" data-testid="probe-step-tenant">
          {renderStepIcon(stepStatus.tenantValidation)}
          <span className="probe-step-label">Tenant Isolation Validation</span>
        </li>
        <li className="probe-step-item" data-testid="probe-step-capabilities">
          {renderStepIcon(stepStatus.capabilityProbe)}
          <span className="probe-step-label">Capability Matrix Probe</span>
        </li>
      </ul>

      {errorMessage && (
        <div className="error-banner" role="alert" data-testid="probing-error">
          {errorMessage}
        </div>
      )}

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="retry-probe-button"
          onClick={onRetryProbe}
          disabled={isLoading}
        >
          {isLoading ? 'Probing...' : 'Retry Probe'}
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
