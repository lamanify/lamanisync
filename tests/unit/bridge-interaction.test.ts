// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IsolatedContentBridge, type MessageListenerCallback } from '../../src/content/content-script.js';
import { MainWorldRunner } from '../../src/page/page-world.js';

interface ObservationPayloadData {
  endpoint: string;
  data: {
    data: Array<{ id: string }>;
    token?: string;
  };
}

interface ActionExecutionResponse {
  success: boolean;
  code?: string;
  result?: {
    status: string;
    data: {
      id: string;
    };
  };
}

describe('Cross-World Bridge & Runner Integration (Phase 5)', () => {
  const origin = 'http://localhost:4001';
  let bridge: IsolatedContentBridge;
  let runner: MainWorldRunner;
  let sentRuntimeMessages: Array<{ type: string; payload: ObservationPayloadData }> = [];
  let runtimeListeners: MessageListenerCallback[] = [];

  let originalPostMessage: typeof window.postMessage;

  beforeEach(() => {
    sentRuntimeMessages = [];
    runtimeListeners = [];

    // Configure window.location
    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost:4001/'),
      writable: true,
    });

    // JSDOM does not populate origin or source on postMessage; emulate browser behavior
    originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown, targetOrigin?: string | WindowPostMessageOptions) => {
      const resolvedOrigin = typeof targetOrigin === 'string' && targetOrigin !== '*' ? targetOrigin : origin;
      const event = new MessageEvent('message', {
        data,
        origin: resolvedOrigin,
        source: window,
      });
      window.dispatchEvent(event);
    }) as typeof window.postMessage;

    const mockChromeRuntime = {
      sendMessage: vi.fn(async (msg: unknown) => {
        sentRuntimeMessages.push(msg as { type: string; payload: ObservationPayloadData });
        return { ok: true };
      }),
      onMessage: {
        addListener: vi.fn((fn: MessageListenerCallback) => {
          runtimeListeners.push(fn);
        }),
        removeListener: vi.fn((fn: MessageListenerCallback) => {
          runtimeListeners = runtimeListeners.filter((l) => l !== fn);
        }),
      },
    };

    // Instantiate both worlds connected via the DOM window
    bridge = new IsolatedContentBridge({
      targetWindow: window,
      targetOrigin: origin,
      chromeRuntime: mockChromeRuntime,
    });

    runner = new MainWorldRunner({
      targetWindow: window,
      targetOrigin: origin,
    });
  });

  afterEach(() => {
    bridge.stop();
    runner.stop();
    if (originalPostMessage) {
      window.postMessage = originalPostMessage;
    }
    vi.restoreAllMocks();
  });

  it('successfully completes handshake and establishes cross-world communication', async () => {
    expect(bridge.isHandshakeReady()).toBe(false);
    expect(runner.getHandshakeToken()).toBeNull();

    // Start runner first, then bridge
    runner.start();
    bridge.start();

    // Allow postMessage microtasks to dispatch
    await new Promise((r) => setTimeout(r, 50));

    expect(bridge.isHandshakeReady()).toBe(true);
    expect(runner.getHandshakeToken()).toBe(bridge.getHandshakeToken());
  });

  it('forwards observed appointment reads from MAIN world to Service Worker', async () => {
    // Mock CMS fetch response before installing runner observer
    window.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ id: 'APT-101', startTime: '2026-09-25T11:00:00+08:00' }],
          token: 'sensitive-token-must-not-leak',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    runner.start();
    bridge.start();
    await new Promise((r) => setTimeout(r, 50));

    // Page executes fetch to allowlisted endpoint
    await window.fetch('http://localhost:4001/api/appointments');

    await new Promise((r) => setTimeout(r, 50));

    expect(sentRuntimeMessages).toHaveLength(1);
    const msg = sentRuntimeMessages[0];
    expect(msg.type).toBe('CMS_OBSERVATION');
    expect(msg.payload.endpoint).toBe('/api/appointments');
    expect(msg.payload.data.data[0].id).toBe('APT-101');
    expect(msg.payload.data.token).toBeUndefined(); // Zero secret leakage (Rule 4)
  });

  it('relays allowlisted action execution from Service Worker to MAIN runner and back', async () => {
    // Mock CMS fetch for create appointment before installing runner
    window.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toContain('/api/appointments');
      expect(init?.credentials).toBe('include');
      return new Response(
        JSON.stringify({
          data: {
            id: 'APT-202',
            patientId: 'P01',
            providerId: 'DOC01',
            startTime: '2026-09-25T14:00:00+08:00',
            endTime: '2026-09-25T14:30:00+08:00',
            status: 'booked',
            rev: 1,
            createdAt: '2026-09-21T07:00:00Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    });

    runner.start();
    bridge.start();
    await new Promise((r) => setTimeout(r, 50));

    // Simulate message from background service worker
    const handler = runtimeListeners[0];
    expect(handler).toBeDefined();

    const responsePromise = new Promise<ActionExecutionResponse>((resolve) => {
      handler(
        {
          type: 'EXECUTE_PAGE_ACTION',
          actionId: 'ACTION_APPOINTMENT_CREATE',
          parameters: {
            patientId: 'P01',
            providerId: 'DOC01',
            startTime: '2026-09-25T14:00:00+08:00',
            endTime: '2026-09-25T14:30:00+08:00',
          },
        },
        {},
        (res) => resolve(res as ActionExecutionResponse)
      );
    });

    const response = await responsePromise;
    expect(response.success).toBe(true);
    expect(response.result?.status).toBe('SUCCESS');
    expect(response.result?.data.id).toBe('APT-202');
  });

  it('rejects arbitrary action ID requests from service worker immediately', async () => {
    runner.start();
    bridge.start();
    await new Promise((r) => setTimeout(r, 50));

    const handler = runtimeListeners[0];
    const responsePromise = new Promise<ActionExecutionResponse>((resolve) => {
      handler(
        {
          type: 'EXECUTE_PAGE_ACTION',
          actionId: 'ACTION_ARBITRARY_URL_EXEC',
          parameters: { url: 'https://attacker.com' },
        },
        {},
        (res) => resolve(res as ActionExecutionResponse)
      );
    });

    const response = await responsePromise;
    expect(response.success).toBe(false);
    expect(response.code).toBe('UNSUPPORTED_ACTION_ID');
  });
});
