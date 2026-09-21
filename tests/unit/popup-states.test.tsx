import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UnpairedView } from '../../src/popup/states/UnpairedView.js';
import { PermissionPromptView } from '../../src/popup/states/PermissionPromptView.js';
import { ProbingView } from '../../src/popup/states/ProbingView.js';
import { ShadowView } from '../../src/popup/states/ShadowView.js';
import { ActiveView } from '../../src/popup/states/ActiveView.js';
import { ReauthView } from '../../src/popup/states/ReauthView.js';
import { DegradedView } from '../../src/popup/states/DegradedView.js';
import { PausedView } from '../../src/popup/states/PausedView.js';
import { RevokedView } from '../../src/popup/states/RevokedView.js';
import { ConfirmDialog } from '../../src/popup/components/ConfirmDialog.js';

describe('Phase 9 Connection States & Popup UI Tests', () => {
  describe('Dedicated State Views Rendering', () => {
    it('1. UNPAIRED: renders pairing code input, explanation, and pair action', () => {
      const onPair = vi.fn();
      render(<UnpairedView onPair={onPair} />);

      expect(screen.getByTestId('unpaired-view')).toBeDefined();
      expect(screen.getByTestId('unpaired-badge').textContent).toBe('UNPAIRED');
      expect(screen.getByTestId('pairing-code-input')).toBeDefined();

      const pairBtn = screen.getByTestId('pair-button');
      expect(pairBtn).toBeDefined();
      expect((pairBtn as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByTestId('pairing-code-input'), {
        target: { value: 'PAIR-ABCD' },
      });
      expect((screen.getByTestId('pairing-code-input') as HTMLInputElement).value).toBe('PAIR-ABCD');
      expect((pairBtn as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(pairBtn);
      expect(onPair).toHaveBeenCalledWith('PAIR-ABCD');
    });

    it('2. PAIRED_NO_PERMISSION: renders plain-language explanation, exact CMS origin, and Grant button', () => {
      const onGrant = vi.fn();
      const onUnpair = vi.fn();

      render(
        <PermissionPromptView
          targetOrigin="http://localhost:4001"
          clinicId="CLN-TEST-01"
          onGrantPermission={onGrant}
          onUnpair={onUnpair}
        />
      );

      expect(screen.getByTestId('paired-no-permission-view')).toBeDefined();
      expect(screen.getByTestId('target-origin').textContent).toBe('http://localhost:4001');
      expect(screen.getByTestId('clinic-id').textContent).toBe('CLN-TEST-01');
      expect(screen.getByTestId('permission-needed-badge')).toBeDefined();

      const grantBtn = screen.getByTestId('grant-permission-button');
      fireEvent.click(grantBtn);
      expect(onGrant).toHaveBeenCalledTimes(1);

      const unpairBtn = screen.getByTestId('unpair-button');
      fireEvent.click(unpairBtn);
      expect(onUnpair).toHaveBeenCalledTimes(1);
    });

    it('3. PROBING: renders visual progress indicators for version, tenant, and capability checks', () => {
      const onRetry = vi.fn();
      const onUnpair = vi.fn();

      render(
        <ProbingView
          targetOrigin="http://localhost:4001"
          stepStatus={{
            versionCheck: 'completed',
            tenantValidation: 'in_progress',
            capabilityProbe: 'pending',
          }}
          onRetryProbe={onRetry}
          onUnpair={onUnpair}
        />
      );

      expect(screen.getByTestId('probing-view')).toBeDefined();
      expect(screen.getByTestId('probing-badge').textContent).toBe('PROBING');
      expect(screen.getByTestId('target-origin').textContent).toBe('http://localhost:4001');
      expect(screen.getByTestId('probe-step-version')).toBeDefined();
      expect(screen.getByTestId('probe-step-tenant')).toBeDefined();
      expect(screen.getByTestId('probe-step-capabilities')).toBeDefined();

      const retryBtn = screen.getByTestId('retry-probe-button');
      fireEvent.click(retryBtn);
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('4. SHADOW: renders read-only badge, historical sync progress, and last read timestamp', () => {
      const onUnpair = vi.fn();
      const lastRead = '2026-09-21T10:30:00.000Z';

      render(
        <ShadowView
          clinicName="Klinik Dr. Azri"
          clinicId="CLN-MYS-01"
          targetOrigin="http://localhost:4001"
          syncProgress={65}
          lastReadAt={lastRead}
          onUnpair={onUnpair}
        />
      );

      expect(screen.getByTestId('shadow-view')).toBeDefined();
      expect(screen.getByTestId('shadow-badge').textContent).toBe('SHADOW MODE');
      expect(screen.getByTestId('clinic-name').textContent).toBe('Klinik Dr. Azri');
      expect(screen.getByTestId('clinic-id').textContent).toBe('CLN-MYS-01');
      expect(screen.getByTestId('sync-progress').textContent).toBe('65%');
      expect(screen.getByTestId('last-read-timestamp')).toBeDefined();
    });

    it('5. ACTIVE: renders green operational badge, clinic name, origin, freshness timestamps, and adapter version', () => {
      const onOpenDiagnostics = vi.fn();
      const onUnpair = vi.fn();
      const lastRead = '2026-09-21T10:30:00.000Z';
      const lastWrite = '2026-09-21T10:35:00.000Z';

      render(
        <ActiveView
          clinicName="Medivest Primary Care"
          clinicId="CLN-99"
          targetOrigin="https://cms.medivest.com"
          adapterVersion="1.2.0"
          lastReadAt={lastRead}
          lastWriteAt={lastWrite}
          onOpenDiagnostics={onOpenDiagnostics}
          onUnpair={onUnpair}
        />
      );

      expect(screen.getByTestId('active-view')).toBeDefined();
      expect(screen.getByTestId('active-badge').textContent).toContain('ACTIVE');
      expect(screen.getByTestId('clinic-name').textContent).toBe('Medivest Primary Care');
      expect(screen.getByTestId('clinic-id').textContent).toBe('CLN-99');
      expect(screen.getByTestId('target-origin').textContent).toBe('https://cms.medivest.com');
      expect(screen.getByTestId('adapter-version').textContent).toBe('v1.2.0');
      expect(screen.getByTestId('last-read-timestamp')).toBeDefined();
      expect(screen.getByTestId('last-write-timestamp')).toBeDefined();

      const diagBtn = screen.getByTestId('open-diagnostics-button');
      fireEvent.click(diagBtn);
      expect(onOpenDiagnostics).toHaveBeenCalledTimes(1);
    });

    it('6. REAUTH_REQUIRED: renders amber alert explaining expired session, and login button', () => {
      const onOpenCmsTab = vi.fn();
      const onRetry = vi.fn();
      const onUnpair = vi.fn();

      render(
        <ReauthView
          targetOrigin="http://localhost:4001"
          onOpenCmsTab={onOpenCmsTab}
          onRetry={onRetry}
          onUnpair={onUnpair}
        />
      );

      expect(screen.getByTestId('reauth-view')).toBeDefined();
      expect(screen.getByTestId('reauth-badge').textContent).toBe('REAUTH REQUIRED');
      expect(screen.getByTestId('target-origin').textContent).toBe('http://localhost:4001');

      const loginBtn = screen.getByTestId('open-cms-button');
      fireEvent.click(loginBtn);
      expect(onOpenCmsTab).toHaveBeenCalledTimes(1);

      const retryBtn = screen.getByTestId('retry-button');
      fireEvent.click(retryBtn);
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('7. DEGRADED: renders sanitized error summary without PHI, retry action, and diagnostics button', () => {
      const onRetry = vi.fn();
      const onOpenDiagnostics = vi.fn();
      const onUnpair = vi.fn();

      render(
        <DegradedView
          errorSummary="Rate limit exceeded by upstream server (429)"
          targetOrigin="http://localhost:4001"
          onRetry={onRetry}
          onOpenDiagnostics={onOpenDiagnostics}
          onUnpair={onUnpair}
        />
      );

      expect(screen.getByTestId('degraded-view')).toBeDefined();
      expect(screen.getByTestId('degraded-badge').textContent).toBe('DEGRADED');
      expect(screen.getByTestId('error-summary').textContent).toContain('Rate limit exceeded');

      const retryBtn = screen.getByTestId('retry-button');
      fireEvent.click(retryBtn);
      expect(onRetry).toHaveBeenCalledTimes(1);

      const diagBtn = screen.getByTestId('view-diagnostics-button');
      fireEvent.click(diagBtn);
      expect(onOpenDiagnostics).toHaveBeenCalledTimes(1);
    });

    it('8. PAUSED: renders kill-switch reason / maintenance info and pause badge', () => {
      const onRefresh = vi.fn();
      const onUnpair = vi.fn();

      render(
        <PausedView
          pauseReason="Scheduled CMS database maintenance until 14:00 UTC"
          targetOrigin="http://localhost:4001"
          onRefresh={onRefresh}
          onUnpair={onUnpair}
        />
      );

      expect(screen.getByTestId('paused-view')).toBeDefined();
      expect(screen.getByTestId('paused-badge').textContent).toBe('PAUSED');
      expect(screen.getByTestId('pause-reason').textContent).toBe(
        'Scheduled CMS database maintenance until 14:00 UTC'
      );

      const refreshBtn = screen.getByTestId('retry-button');
      fireEvent.click(refreshBtn);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('9. REVOKED: renders disconnected state with clear state button', () => {
      const onClearState = vi.fn();

      render(<RevokedView onClearState={onClearState} />);

      expect(screen.getByTestId('revoked-view')).toBeDefined();
      expect(screen.getByTestId('revoked-badge').textContent).toBe('REVOKED');

      const clearBtn = screen.getByTestId('clear-state-button');
      fireEvent.click(clearBtn);
      expect(onClearState).toHaveBeenCalledTimes(1);
    });
  });

  describe('Keyboard Navigation & Accessibility', () => {
    it('supports keyboard form submission via Enter key on unpaired view', () => {
      const onPair = vi.fn();
      render(<UnpairedView onPair={onPair} />);

      const input = screen.getByTestId('pairing-code-input');
      fireEvent.change(input, { target: { value: 'PAIR-KBD-1' } });
      fireEvent.submit(input);

      expect(onPair).toHaveBeenCalledWith('PAIR-KBD-1');
    });

    it('renders accessible confirmation dialog and handles cancel / confirm', () => {
      const onConfirm = vi.fn();
      const onCancel = vi.fn();

      const { rerender } = render(
        <ConfirmDialog
          isOpen={true}
          title="Confirm Device Unpair"
          message="Are you sure you want to unpair this device?"
          onConfirm={onConfirm}
          onCancel={onCancel}
          testId="unpair-confirm-dialog"
        />
      );

      expect(screen.getByTestId('unpair-confirm-dialog')).toBeDefined();
      expect(screen.getByRole('alertdialog')).toBeDefined();

      // Click cancel
      const cancelBtn = screen.getByTestId('cancel-unpair-button');
      fireEvent.click(cancelBtn);
      expect(onCancel).toHaveBeenCalledTimes(1);

      // Trigger ESC key
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onCancel).toHaveBeenCalledTimes(2);

      // Confirm unpair
      const confirmBtn = screen.getByTestId('confirm-unpair-button');
      fireEvent.click(confirmBtn);
      expect(onConfirm).toHaveBeenCalledTimes(1);

      // Closed dialog does not render
      rerender(
        <ConfirmDialog
          isOpen={false}
          title="Confirm Device Unpair"
          message="Are you sure you want to unpair this device?"
          onConfirm={onConfirm}
          onCancel={onCancel}
          testId="unpair-confirm-dialog"
        />
      );
      expect(screen.queryByTestId('unpair-confirm-dialog')).toBeNull();
    });
  });

  describe('Automated PHI Leakage Prevention Test Across States', () => {
    it('guarantees zero NRIC, patient names, or bearer tokens in rendered DOM strings', () => {
      const taintedPHI = {
        name: 'Lee Chong Wei',
        nric: '821021-14-5566',
        token: 'Bearer super_secret_bearer_token_xyz',
      };

      // Test DegradedView with tainted error string containing PHI & bearer token
      const taintedError = `Failed processing patient ${taintedPHI.name} (NRIC: ${taintedPHI.nric}) using ${taintedPHI.token}`;

      const { container } = render(
        <DegradedView
          errorSummary={taintedError}
          targetOrigin="http://localhost:4001"
          onRetry={vi.fn()}
          onOpenDiagnostics={vi.fn()}
          onUnpair={vi.fn()}
        />
      );

      const html = container.innerHTML;

      expect(html).not.toContain(taintedPHI.nric);
      expect(html).not.toContain(taintedPHI.name);
      expect(html).not.toContain('super_secret_bearer_token_xyz');
      expect(html).toContain('[REDACTED_NRIC]');
      expect(html).toContain('Bearer [REDACTED]');
    });
  });
});
