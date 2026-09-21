export interface RevokedViewProps {
  isLoading?: boolean;
  onClearState: () => void;
}

export function RevokedView({
  isLoading = false,
  onClearState,
}: RevokedViewProps) {
  return (
    <div className="state-card" data-testid="revoked-view">
      <div className="card-header">
        <h2 className="card-title">Device Revoked</h2>
        <span className="badge badge-danger" data-testid="revoked-badge">
          REVOKED
        </span>
      </div>

      <div className="alert-box alert-rose">
        <p className="alert-title">Connection Decommissioned</p>
        <p className="card-desc">
          This device installation has been revoked by LamaniHub or uncoupled from the clinic tenant. Cryptographic keys and active sessions must be cleared to allow re-pairing.
        </p>
      </div>

      <p className="card-desc">
        Click below to purge local credentials and reset the extension to the unpaired state.
      </p>

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-danger"
          data-testid="clear-state-button"
          onClick={onClearState}
          disabled={isLoading}
        >
          {isLoading ? 'Clearing State...' : 'Clear Local State & Reset'}
        </button>
      </div>
    </div>
  );
}
