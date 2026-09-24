import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { App } from '../../src/popup/App';

describe('Popup App Component', () => {
  let messageListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => void>;

  beforeEach(() => {
    messageListeners = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        getManifest: vi.fn(() => ({
          version: '0.1.0',
          name: 'LamaniSync Dev',
        })),
        sendMessage: vi.fn((_msg, cb) => {
          if (cb) cb({ record: { state: 'UNPAIRED' } });
        }),
        onMessage: {
          addListener: vi.fn((cb) => messageListeners.push(cb)),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 101 }),
        update: vi.fn().mockResolvedValue({}),
      },
      windows: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders extension title and Unpaired state', () => {
    render(<App />);

    expect(screen.getByText('LamaniSync Dev')).toBeTruthy();
    expect(screen.getByText('Unpaired')).toBeTruthy();
  });

  it('dynamically displays version from manifest instead of hardcoded value', () => {
    render(<App />);

    const versionElement = screen.getByTestId('extension-version');
    expect(versionElement.textContent).toBe('v0.1.0');
  });

  it('opens and closes the Diagnostics modal via header button and ESC key', () => {
    render(<App />);

    expect(screen.queryByTestId('diagnostics-modal')).toBeNull();

    const diagHeaderBtn = screen.getByTestId('header-diagnostics-button');
    fireEvent.click(diagHeaderBtn);

    expect(screen.getByTestId('diagnostics-modal')).toBeDefined();

    // Close via ESC
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('diagnostics-modal')).toBeNull();

    // Reopen and close via close button
    fireEvent.click(diagHeaderBtn);
    expect(screen.getByTestId('diagnostics-modal')).toBeDefined();
    fireEvent.click(screen.getByTestId('close-modal-button'));
    expect(screen.queryByTestId('diagnostics-modal')).toBeNull();
  });

  it('reactively updates view when CONNECTION_STATE_CHANGED runtime message arrives', async () => {
    render(<App />);

    expect(screen.getByTestId('unpaired-view')).toBeDefined();

    // Broadcast state change to ACTIVE
    await act(async () => {
      for (const listener of messageListeners) {
        listener(
          {
            type: 'CONNECTION_STATE_CHANGED',
            record: {
              state: 'ACTIVE',
              targetOrigin: 'http://localhost:4001',
              metadata: {
                clinicName: 'Poliklinik Impian',
                lastReadAt: '2026-09-21T10:00:00.000Z',
                lastWriteAt: '2026-09-21T10:05:00.000Z',
                adapterVersion: '1.2.3',
              },
            },
          },
          {},
          () => {}
        );
      }
    });

    expect(screen.getByTestId('active-view')).toBeDefined();
    expect(screen.getByTestId('clinic-name').textContent).toBe('Poliklinik Impian');
    expect(screen.getByTestId('adapter-version').textContent).toBe('v1.2.3');
  });

  it('displays "Connecting..." in status badge when state is PROBING', async () => {
    (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation((msg, cb) => {
      if (msg?.type === 'GET_CONNECTION_STATE') {
        cb({ record: { state: 'PROBING', targetOrigin: 'https://app.lamanipulse.com' } });
      } else if (msg?.type === 'RUN_PROBE') {
        cb({ success: true, record: { state: 'PROBING', targetOrigin: 'https://app.lamanipulse.com' } });
      } else if (cb) {
        cb({ record: { state: 'PROBING' } });
      }
    });

    render(<App />);

    const statusBadge = await screen.findByTestId('connection-status');
    expect(statusBadge.textContent).toContain('Connecting...');
    expect(statusBadge.textContent).not.toContain('Connected');
  });

  it('triggers confirmation dialog on unpair and cancels or confirms', async () => {
    render(<App />);

    // Broadcast state change to ACTIVE
    await act(async () => {
      for (const listener of messageListeners) {
        listener(
          {
            type: 'CONNECTION_STATE_CHANGED',
            record: {
              state: 'ACTIVE',
              targetOrigin: 'http://localhost:4001',
            },
          },
          {},
          () => {}
        );
      }
    });

    // Click Unpair in ActiveView
    const unpairBtn = screen.getByTestId('unpair-button');
    await act(async () => {
      fireEvent.click(unpairBtn);
    });

    // Confirm dialog appears
    const dialog = screen.getByTestId('unpair-confirm-dialog');
    expect(dialog).toBeDefined();

    // Click cancel
    await act(async () => {
      fireEvent.click(screen.getByTestId('cancel-unpair-button'));
    });
    expect(screen.queryByTestId('unpair-confirm-dialog')).toBeNull();

    // Reopen and confirm unpair
    await act(async () => {
      fireEvent.click(screen.getByTestId('unpair-button'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-unpair-button'));
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'UNPAIR' }),
      expect.any(Function)
    );
  });

  it('triggers confirmation dialog on REVOKED and calls clearLocalState upon confirm', async () => {
    render(<App />);

    // Broadcast state change to REVOKED
    await act(async () => {
      for (const listener of messageListeners) {
        listener(
          {
            type: 'CONNECTION_STATE_CHANGED',
            record: {
              state: 'REVOKED',
              reason: 'Device decommissioned',
            },
          },
          {},
          () => {}
        );
      }
    });

    expect(screen.getByTestId('revoked-view')).toBeDefined();

    // Click Clear Local State
    await act(async () => {
      fireEvent.click(screen.getByTestId('clear-state-button'));
    });

    // Confirm dialog appears
    expect(screen.getByTestId('unpair-confirm-dialog')).toBeDefined();
    expect(screen.getByTestId('confirm-unpair-button')).toBeDefined();

    // Confirm clear state
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-unpair-button'));
    });

    expect(chrome.storage.local.remove).toHaveBeenCalled();
  });
});
