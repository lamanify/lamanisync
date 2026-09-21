import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConnectionState } from '../../src/popup/hooks/useConnectionState.js';
import { SESSION_STORAGE_KEY } from '../../src/background/pairing.js';

describe('useConnectionState Hook Unit Tests', () => {
  let messageListeners: Array<(msg: unknown, sender: unknown, sendResponse: (res: unknown) => void) => void>;

  beforeEach(() => {
    messageListeners = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        getManifest: vi.fn(() => ({ version: '0.1.0' })),
        sendMessage: vi.fn((msg: { type: string }, cb?: (res: unknown) => void) => {
          if (cb) {
            if (msg.type === 'GET_CONNECTION_STATE') {
              cb({
                record: {
                  state: 'ACTIVE',
                  targetOrigin: 'https://cms.test.com',
                  metadata: { clinicName: 'Test Clinic' },
                },
              });
            } else if (msg.type === 'RUN_PROBE') {
              cb({
                success: true,
                record: {
                  state: 'ACTIVE',
                  targetOrigin: 'https://cms.test.com',
                  metadata: { clinicName: 'Test Clinic' },
                },
              });
            } else if (msg.type === 'GRANT_PERMISSION_RESULT') {
              cb({
                success: true,
                record: {
                  state: 'PROBING',
                  targetOrigin: 'https://cms.test.com',
                },
              });
            } else {
              cb({ success: true });
            }
          }
        }),
        onMessage: {
          addListener: vi.fn((cb) => messageListeners.push(cb)),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn().mockImplementation(async (key: string) => {
            if (key === SESSION_STORAGE_KEY) {
              return {
                [SESSION_STORAGE_KEY]: {
                  installationId: 'INST-001',
                  connectionId: 'CONN-001',
                  clinicId: 'CLN-001',
                  sessionToken: 'TOK-001',
                  expiresAt: new Date(Date.now() + 100000).toISOString(),
                  targetOrigin: 'https://cms.test.com',
                  pairedAt: new Date().toISOString(),
                },
              };
            }
            return {};
          }),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      permissions: {
        request: vi.fn().mockResolvedValue(true),
        contains: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
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

  it('openCmsTab focuses existing CMS tab and window if tab exists', async () => {
    (chrome.tabs.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 42, windowId: 7, url: 'https://cms.test.com/patients' },
    ]);

    const { result } = renderHook(() => useConnectionState());

    // Give effect time to load session
    await act(async () => {
      await result.current.refreshState();
    });

    await act(async () => {
      await result.current.openCmsTab();
    });

    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(7, { focused: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('openCmsTab creates a new tab if no existing matching tab is open', async () => {
    (chrome.tabs.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 99, windowId: 1, url: 'https://other-site.com' },
    ]);

    const { result } = renderHook(() => useConnectionState());

    await act(async () => {
      await result.current.refreshState();
    });

    await act(async () => {
      await result.current.openCmsTab();
    });

    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://cms.test.com' });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('retry sends RUN_PROBE when in DEGRADED state', async () => {
    const { result } = renderHook(() => useConnectionState());

    // Switch to DEGRADED
    await act(async () => {
      for (const listener of messageListeners) {
        listener(
          {
            type: 'CONNECTION_STATE_CHANGED',
            record: {
              state: 'DEGRADED',
              targetOrigin: 'https://cms.test.com',
              reason: 'Probe timeout',
            },
          },
          {},
          () => {}
        );
      }
    });

    expect(result.current.connectionState).toBe('DEGRADED');

    // Trigger retry
    await act(async () => {
      await result.current.retry();
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RUN_PROBE' }),
      expect.any(Function)
    );
  });

  it('applies verifiedAt as fallback for lastWriteAt in applyRecordMetadata', async () => {
    const { result } = renderHook(() => useConnectionState());

    await act(async () => {
      for (const listener of messageListeners) {
        listener(
          {
            type: 'CONNECTION_STATE_CHANGED',
            record: {
              state: 'ACTIVE',
              targetOrigin: 'https://cms.test.com',
              metadata: {
                verifiedAt: '2026-09-21T10:45:00.000Z',
              },
            },
          },
          {},
          () => {}
        );
      }
    });

    expect(result.current.lastWriteAt).toBe('2026-09-21T10:45:00.000Z');
  });
});
