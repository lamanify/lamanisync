// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { MockCmsServer } from '../../test-harness/mock-cms/server.js';
import { IsolatedContentBridge, type MessageListenerCallback } from '../../src/content/content-script.js';
import { MainWorldRunner } from '../../src/page/page-world.js';
import {
  ACTION_APPOINTMENT_CREATE,
  ACTION_APPOINTMENT_VERIFY,
} from '../../src/page/action-runner.js';

interface SwActionResponse {
  success: boolean;
  code?: string;
  error?: string;
  result?: {
    status: string;
    data: {
      id: string;
      startTime: string;
    };
  };
}

interface SwObservationMessage {
  type: string;
  payload: {
    endpoint: string;
    statusCode: number;
    headers?: unknown;
    data: {
      data: Array<{ id: string }>;
      forged?: boolean;
    };
  };
}

describe('Phase 5: Safe Page Integration Test with Mock CMS', () => {
  const CMS_PORT = 4011;
  const targetOrigin = `http://localhost:${CMS_PORT}`;
  let cmsServer: MockCmsServer;

  let bridge: IsolatedContentBridge;
  let runner: MainWorldRunner;
  let sentSwMessages: SwObservationMessage[] = [];
  let swRuntimeListeners: MessageListenerCallback[] = [];
  let originalPostMessage: typeof window.postMessage;

  beforeAll(async () => {
    cmsServer = new MockCmsServer(CMS_PORT);
    await cmsServer.start();
  });

  afterAll(async () => {
    if (cmsServer) {
      await cmsServer.stop();
    }
  });

  beforeEach(() => {
    sentSwMessages = [];
    swRuntimeListeners = [];

    // Reset CMS state
    cmsServer.reset();

    // Set page origin to Mock CMS
    Object.defineProperty(window, 'location', {
      value: new URL(`${targetOrigin}/`),
      writable: true,
    });

    // Emulate browser postMessage with proper origin and source in jsdom
    originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown, postOrigin?: string | WindowPostMessageOptions) => {
      const resolved = typeof postOrigin === 'string' && postOrigin !== '*' ? postOrigin : targetOrigin;
      const event = new MessageEvent('message', {
        data,
        origin: resolved,
        source: window,
      });
      window.dispatchEvent(event);
    }) as typeof window.postMessage;

    const mockChromeRuntime = {
      sendMessage: vi.fn(async (msg: unknown) => {
        sentSwMessages.push(msg as SwObservationMessage);
        return { ok: true };
      }),
      onMessage: {
        addListener: vi.fn((fn: MessageListenerCallback) => {
          swRuntimeListeners.push(fn);
        }),
        removeListener: vi.fn((fn: MessageListenerCallback) => {
          swRuntimeListeners = swRuntimeListeners.filter((l) => l !== fn);
        }),
      },
    };

    bridge = new IsolatedContentBridge({
      targetWindow: window,
      targetOrigin,
      chromeRuntime: mockChromeRuntime,
    });

    runner = new MainWorldRunner({
      targetWindow: window,
      targetOrigin,
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

  it('completes cross-world handshake and observes staff appointment fetch', async () => {
    runner.start();
    bridge.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(bridge.isHandshakeReady()).toBe(true);
    expect(runner.getHandshakeToken()).toBe(bridge.getHandshakeToken());

    // Execute real fetch against live Mock CMS server
    const res = await window.fetch(`${targetOrigin}/api/appointments`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThan(0);

    // Allow observer postMessage and forwarding microtasks
    await new Promise((r) => setTimeout(r, 60));

    // Verify observation reached the background service worker
    expect(sentSwMessages.length).toBeGreaterThanOrEqual(1);
    const obsMsg = sentSwMessages.find((m) => m.type === 'CMS_OBSERVATION');
    expect(obsMsg).toBeDefined();
    expect(obsMsg?.payload.endpoint).toBe('/api/appointments');
    expect(obsMsg?.payload.statusCode).toBe(200);
    expect(obsMsg?.payload.data.data.length).toBe(body.data.length);

    // Verify zero secrets leaked (Rule 4): no cookies, no auth headers, no session tokens
    expect(obsMsg?.payload.headers).toBeUndefined();
    expect(JSON.stringify(obsMsg)).not.toContain('cms_session');
    expect(JSON.stringify(obsMsg)).not.toContain('dummy_staff_cookie');
  });

  it('executes predefined ACTION_APPOINTMENT_CREATE and reads back write receipt (Rules 8 & 10)', async () => {
    runner.start();
    bridge.start();
    await new Promise((r) => setTimeout(r, 50));

    const swHandler = swRuntimeListeners[0];
    expect(swHandler).toBeDefined();

    // 1. Execute appointment creation via service worker action message
    const createStartTime = '2026-09-25T16:00:00+08:00';
    const createEndTime = '2026-09-25T16:30:00+08:00';

    const createPromise = new Promise<SwActionResponse>((resolve) => {
      swHandler(
        {
          type: 'EXECUTE_PAGE_ACTION',
          actionId: ACTION_APPOINTMENT_CREATE,
          parameters: {
            patientId: 'P01',
            providerId: 'DOC01',
            startTime: createStartTime,
            endTime: createEndTime,
            notes: 'Phase 5 Integration Created Appointment',
          },
        },
        {},
        (res) => resolve(res as SwActionResponse)
      );
    });

    const createResponse = await createPromise;
    expect(createResponse.success).toBe(true);
    expect(createResponse.result?.status).toBe('SUCCESS');
    expect(createResponse.result?.data.id).toMatch(/^APT-\d+$/);
    const createdId = createResponse.result?.data.id as string;

    // 2. Verify write in live Mock CMS server database
    const cmsCheckRes = await window.fetch(`${targetOrigin}/api/appointments/${createdId}`);
    expect(cmsCheckRes.ok).toBe(true);
    const cmsData = (await cmsCheckRes.json()) as { data: { id: string; patientId: string; notes: string } };
    expect(cmsData.data.id).toBe(createdId);
    expect(cmsData.data.patientId).toBe('P01');
    expect(cmsData.data.notes).toBe('Phase 5 Integration Created Appointment');

    // 3. Read-After-Write verification recipe (AGENTS.md Rule 10)
    const verifyPromise = new Promise<SwActionResponse>((resolve) => {
      swHandler(
        {
          type: 'EXECUTE_PAGE_ACTION',
          actionId: ACTION_APPOINTMENT_VERIFY,
          parameters: { appointmentId: createdId },
        },
        {},
        (res) => resolve(res as SwActionResponse)
      );
    });

    const verifyResponse = await verifyPromise;
    expect(verifyResponse.success).toBe(true);
    expect(verifyResponse.result?.status).toBe('SUCCESS');
    expect(verifyResponse.result?.data.id).toBe(createdId);
    expect(verifyResponse.result?.data.startTime).toBe(createStartTime);
  });

  it('strictly rejects arbitrary remote URL or method execution (AGENTS.md Rule 8)', async () => {
    runner.start();
    bridge.start();
    await new Promise((r) => setTimeout(r, 50));

    const swHandler = swRuntimeListeners[0];

    // Attempt arbitrary URL execution
    const arbitraryPromise = new Promise<SwActionResponse>((resolve) => {
      swHandler(
        {
          type: 'EXECUTE_PAGE_ACTION',
          actionId: 'ACTION_EXECUTE_ARBITRARY_FETCH',
          parameters: {
            url: `${targetOrigin}/__admin/reset`,
            method: 'POST',
          },
        },
        {},
        (res) => resolve(res as SwActionResponse)
      );
    });

    const arbitraryResponse = await arbitraryPromise;
    expect(arbitraryResponse.success).toBe(false);
    expect(arbitraryResponse.code).toBe('UNSUPPORTED_ACTION_ID');

    // Attempt injection of unauthorized parameters inside allowlisted action
    const injectionPromise = new Promise<SwActionResponse>((resolve) => {
      swHandler(
        {
          type: 'EXECUTE_PAGE_ACTION',
          actionId: ACTION_APPOINTMENT_CREATE,
          parameters: {
            patientId: 'P01',
            providerId: 'DOC01',
            startTime: '2026-09-25T17:00:00+08:00',
            endTime: '2026-09-25T17:30:00+08:00',
            url: `${targetOrigin}/__admin/fault`, // unauthorized injected URL
            method: 'POST',
          },
        },
        {},
        (res) => resolve(res as SwActionResponse)
      );
    });

    const injectionResponse = await injectionPromise;
    expect(injectionResponse.success).toBe(false);
    expect(injectionResponse.code).toBe('INVALID_ACTION_PARAMETERS');
  });

  it('fails closed on forged postMessage from untrusted origin or invalid token', async () => {
    runner.start();
    bridge.start();
    await new Promise((r) => setTimeout(r, 50));

    // Dispatch forged message with fake handshake token
    const forgedEvent = new MessageEvent('message', {
      data: {
        channel: 'LAMANISYNC_PAGE_BRIDGE',
        source: 'LAMANISYNC_MAIN',
        token: 'forged-attacker-token',
        type: 'OBSERVATION',
        payload: {
          endpoint: '/api/appointments',
          method: 'GET',
          statusCode: 200,
          data: { forged: true },
          timestamp: new Date().toISOString(),
        },
      },
      origin: targetOrigin,
      source: window,
    });

    window.dispatchEvent(forgedEvent);

    await new Promise((r) => setTimeout(r, 50));

    // Forged observation MUST NOT reach the service worker
    const forgedObservation = sentSwMessages.find((m) => m.payload?.data?.forged === true);
    expect(forgedObservation).toBeUndefined();
  });
});
