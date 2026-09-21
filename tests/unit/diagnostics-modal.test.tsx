import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { DiagnosticsModal } from '../../src/popup/components/DiagnosticsModal.js';
import { formatDiagnosticBundle } from '../../src/core/redaction.js';

describe('DiagnosticsModal Component & Redaction Verification', () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('does not render when isOpen is false', () => {
    const bundle = formatDiagnosticBundle({
      currentState: 'ACTIVE',
      installationId: 'INST-001',
    });

    render(<DiagnosticsModal isOpen={false} onClose={vi.fn()} bundle={bundle} />);

    expect(screen.queryByTestId('diagnostics-modal')).toBeNull();
  });

  it('renders diagnostic fields accurately when isOpen is true', () => {
    const bundle = formatDiagnosticBundle({
      installationId: 'INST-12345',
      adapterVersion: '2.1.0',
      extensionVersion: '0.1.0',
      currentState: 'ACTIVE',
      correlationId: 'CORR-9876',
      targetOrigin: 'http://localhost:4001',
      lastReadAt: '2026-09-21T10:00:00.000Z',
      lastWriteAt: '2026-09-21T10:05:00.000Z',
    });

    render(<DiagnosticsModal isOpen={true} onClose={vi.fn()} bundle={bundle} />);

    expect(screen.getByTestId('diagnostics-modal')).toBeDefined();
    expect(screen.getByTestId('diag-installation-id').textContent).toBe('INST-12345');
    expect(screen.getByTestId('diag-adapter-version').textContent).toBe('2.1.0');
    expect(screen.getByTestId('diag-extension-version').textContent).toBe('0.1.0');
    expect(screen.getByTestId('diag-current-state').textContent).toBe('ACTIVE');
    expect(screen.getByTestId('diag-correlation-id').textContent).toBe('CORR-9876');
    expect(screen.getByTestId('diag-target-origin').textContent).toBe('http://localhost:4001');
    expect(screen.getByTestId('diag-json-content').textContent).toContain('INST-12345');
  });

  it('closes on ESC key press and close button click', () => {
    const onClose = vi.fn();
    const bundle = formatDiagnosticBundle({
      currentState: 'DEGRADED',
      installationId: 'INST-TEST',
    });

    const { unmount } = render(
      <DiagnosticsModal isOpen={true} onClose={onClose} bundle={bundle} />
    );

    // Test close button
    const closeBtn = screen.getByTestId('close-modal-button');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Test ESC key
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('handles one-click copy to clipboard with feedback', async () => {
    const bundle = formatDiagnosticBundle({
      currentState: 'ACTIVE',
      installationId: 'INST-COPY-TEST',
    });

    render(<DiagnosticsModal isOpen={true} onClose={vi.fn()} bundle={bundle} />);

    const copyBtn = screen.getByTestId('copy-diagnostics-button');
    expect(copyBtn.textContent).toContain('Copy Diagnostic Bundle');

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copiedText = (navigator.clipboard.writeText as unknown as { mock: { calls: string[][] } })
      .mock.calls[0][0];
    expect(copiedText).toContain('INST-COPY-TEST');
    await waitFor(() => {
      expect(copyBtn.textContent).toContain('Copied');
    });
  });

  it('strictly scrubs all PHI, credentials, and query params from DOM strings', () => {
    // Malicious or leaked raw input with PHI and secrets
    const taintedInput = {
      installationId: 'INST-SECURE-99',
      adapterVersion: '1.0.0',
      extensionVersion: '0.1.0',
      currentState: 'DEGRADED',
      correlationId: 'corr_test_123',
      targetOrigin: 'https://clinic.example.com/cms?token=secret_auth_token&nric=900101-14-5001',
      error: 'Failed to process patient Siti Aminah with NRIC 900101-14-5001 and phone +60123456789 (Bearer secret_jwt_token_xyz)',
      rawDetails: {
        patientName: 'Siti Aminah',
        nric: '900101-14-5001',
        mobilePhone: '+60123456789',
        sessionCookie: 'cms_session=super_secret_cookie_123',
        password: 'PlainTextPassword!',
        address: '123 Jalan Ampang, Kuala Lumpur',
        diagnosisNotes: 'Severe chronic hypertension',
        safeCode: 'DIAG_CODE_409',
      },
    };

    const bundle = formatDiagnosticBundle(taintedInput);
    const { container } = render(
      <DiagnosticsModal isOpen={true} onClose={vi.fn()} bundle={bundle} />
    );

    const fullDomHtml = container.innerHTML;

    // Zero PHI leakage assertions
    expect(fullDomHtml).not.toContain('900101-14-5001');
    expect(fullDomHtml).not.toContain('Siti Aminah');
    expect(fullDomHtml).not.toContain('+60123456789');
    expect(fullDomHtml).not.toContain('secret_auth_token');
    expect(fullDomHtml).not.toContain('secret_jwt_token_xyz');
    expect(fullDomHtml).not.toContain('super_secret_cookie_123');
    expect(fullDomHtml).not.toContain('PlainTextPassword!');
    expect(fullDomHtml).not.toContain('123 Jalan Ampang');
    expect(fullDomHtml).not.toContain('Severe chronic hypertension');

    // Query parameters stripped
    expect(fullDomHtml).not.toContain('?token=');
    expect(fullDomHtml).toContain('https://clinic.example.com/cms');

    // Retains safe non-PHI
    expect(fullDomHtml).toContain('INST-SECURE-99');
    expect(fullDomHtml).toContain('DIAG_CODE_409');
    expect(fullDomHtml).toContain('[REDACTED]');
    expect(fullDomHtml).toContain('Bearer [REDACTED]');
  });
});
