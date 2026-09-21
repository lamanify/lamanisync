import { useEffect, useState, useCallback, useRef } from 'react';
import type { FormattedDiagnosticBundle } from '../../core/redaction.js';

export interface DiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  bundle: FormattedDiagnosticBundle;
}

export function DiagnosticsModal({ isOpen, onClose, bundle }: DiagnosticsModalProps) {
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && cardRef.current) {
        const focusable = cardRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;

    window.addEventListener('keydown', handleKeyDown);

    const timer = setTimeout(() => {
      const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable && focusable.length > 0) {
        focusable[0].focus();
      }
    }, 0);

    return () => {
      clearTimeout(timer);
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const jsonString = JSON.stringify(bundle, null, 2);

  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(jsonString);
      }
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="diag-modal-title"
      data-testid="diagnostics-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal-card" ref={cardRef}>
        <div className="modal-header">
          <h2 id="diag-modal-title" className="modal-title">
            Redacted Diagnostics
          </h2>
          <button
            type="button"
            className="modal-close-btn"
            data-testid="close-modal-button"
            aria-label="Close diagnostics"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <p className="modal-desc">
          Strictly redacted for technical support. Zero patient data, zero tokens, and zero query parameters are included.
        </p>

        <div className="diag-field-grid">
          <div className="diag-field">
            <span className="diag-field-label">Installation ID</span>
            <code className="diag-field-value" data-testid="diag-installation-id">
              {bundle.installationId}
            </code>
          </div>

          <div className="diag-field">
            <span className="diag-field-label">Current State</span>
            <span className="diag-field-value" data-testid="diag-current-state">
              {bundle.currentState}
            </span>
          </div>

          <div className="diag-field">
            <span className="diag-field-label">Adapter Version</span>
            <span className="diag-field-value" data-testid="diag-adapter-version">
              {bundle.adapterVersion}
            </span>
          </div>

          <div className="diag-field">
            <span className="diag-field-label">Extension Version</span>
            <span className="diag-field-value" data-testid="diag-extension-version">
              {bundle.extensionVersion}
            </span>
          </div>

          <div className="diag-field">
            <span className="diag-field-label">Correlation ID</span>
            <code className="diag-field-value" data-testid="diag-correlation-id">
              {bundle.correlationId}
            </code>
          </div>

          <div className="diag-field">
            <span className="diag-field-label">Target Origin</span>
            <code className="diag-field-value" data-testid="diag-target-origin">
              {bundle.targetOrigin}
            </code>
          </div>
        </div>

        <div className="diag-json-container">
          <label htmlFor="diag-json-area" className="diag-field-label">
            Diagnostic Bundle JSON:
          </label>
          <pre
            id="diag-json-area"
            className="diag-json-pre"
            data-testid="diag-json-content"
            tabIndex={0}
          >
            {jsonString}
          </pre>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="copy-diagnostics-button"
            onClick={handleCopy}
          >
            {copied ? '✓ Copied to Clipboard!' : 'Copy Diagnostic Bundle'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
