/**
 * Isolated Content Script Bridge (Phase 5)
 * Runs in Chrome's ISOLATED world.
 * Validates cross-world messages, manages session handshake token,
 * forwards observations to the background service worker, and relays
 * predefined action executions from the service worker to the MAIN world runner.
 * Conforms to AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, bearer tokens, or CSRF secrets.
 * Rule 8: Page-world code may execute only predefined adapter action IDs.
 * Rule 9: Validate every message at runtime.
 */

import {
  BRIDGE_CHANNEL,
  SOURCE_ISOLATED,
  SOURCE_MAIN,
  validateIncomingPageMessage,
  type PageToIsolatedMessage,
} from './page-message-validator.js';
import { isAllowlistedActionId } from '../page/action-runner.js';
import { normalizeExactOrigin } from '../background/permissions.js';
import { LamaniError } from '../core/errors.js';

export type MessageListenerCallback = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => boolean | void;

export interface ChromeRuntimeMessagingApi {
  sendMessage(message: unknown): Promise<unknown>;
  onMessage?: {
    addListener(callback: MessageListenerCallback): void;
    removeListener?(callback: MessageListenerCallback): void;
  };
}

export interface IsolatedBridgeOptions {
  targetWindow?: Window;
  chromeRuntime?: ChromeRuntimeMessagingApi;
  targetOrigin?: string;
  handshakeTimeoutMs?: number;
  actionTimeoutMs?: number;
}

interface PendingAction {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class IsolatedContentBridge {
  private targetWindow: Window;
  private chromeRuntime?: ChromeRuntimeMessagingApi;
  private targetOrigin: string;
  private handshakeToken: string;
  private isHandshakeEstablished: boolean = false;
  private pendingActions = new Map<string, PendingAction>();
  private messageListener?: (event: MessageEvent) => void;
  private runtimeListener?: MessageListenerCallback;
  private actionTimeoutMs: number;

  constructor(options: IsolatedBridgeOptions = {}) {
    this.targetWindow = options.targetWindow || (typeof window !== 'undefined' ? window : ({} as Window));
    const rawOrigin = options.targetOrigin || (this.targetWindow.location?.origin || '');
    this.targetOrigin = rawOrigin;
    if (this.targetOrigin && this.targetOrigin !== '*') {
      try {
        this.targetOrigin = normalizeExactOrigin(this.targetOrigin);
      } catch {
        // preserve for validator failure if malformed
      }
    }
    this.chromeRuntime = options.chromeRuntime || (typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime : undefined);
    this.handshakeToken = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `hs-${Date.now()}-${Math.random()}`;
    this.actionTimeoutMs = options.actionTimeoutMs || 10000;
  }

  getHandshakeToken(): string {
    return this.handshakeToken;
  }

  isHandshakeReady(): boolean {
    return this.isHandshakeEstablished;
  }

  start(): void {
    if (!this.targetWindow.addEventListener) return;

    this.messageListener = (event: MessageEvent) => this.handleWindowMessage(event);
    this.targetWindow.addEventListener('message', this.messageListener);

    if (this.chromeRuntime?.onMessage?.addListener) {
      this.runtimeListener = (message, _sender, sendResponse) => this.handleRuntimeMessage(message, sendResponse);
      this.chromeRuntime.onMessage.addListener(this.runtimeListener);
    }

    // Proactively initiate handshake with MAIN world runner
    this.sendHandshakeInit();
  }

  stop(): void {
    if (this.messageListener && this.targetWindow.removeEventListener) {
      this.targetWindow.removeEventListener('message', this.messageListener);
    }
    if (this.runtimeListener && this.chromeRuntime?.onMessage?.removeListener) {
      this.chromeRuntime.onMessage.removeListener(this.runtimeListener);
    }
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new LamaniError('Content bridge stopped', 'BRIDGE_STOPPED'));
    }
    this.pendingActions.clear();
  }

  sendHandshakeInit(challengeNonce?: string): void {
    if (!this.targetOrigin || this.targetOrigin === '*') {
      console.warn('[LamaniSync Isolated] Cannot send handshake init: target origin is missing or wildcard');
      return;
    }
    const initMessage = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_ISOLATED,
      token: this.handshakeToken,
      type: 'HANDSHAKE_INIT',
      payload: { nonce: challengeNonce || ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}`) },
    };
    this.targetWindow.postMessage(initMessage, this.targetOrigin);
  }

  private handleWindowMessage(event: MessageEvent): void {
    const result = validateIncomingPageMessage<PageToIsolatedMessage>({
      event: {
        origin: event.origin,
        source: event.source,
        data: event.data,
      },
      expectedOrigin: this.targetOrigin,
      handshakeToken: this.handshakeToken,
      expectedSource: SOURCE_MAIN,
      currentWindow: this.targetWindow,
    });

    if (!result.success) {
      if (!result.ignored) {
        console.warn('[LamaniSync Isolated] Rejected message from page:', result.diagnostic.errorType);
      }
      return;
    }

    const message = result.message;

    switch (message.type) {
      case 'HANDSHAKE_REQUEST': {
        this.sendHandshakeInit(message.payload.nonce);
        break;
      }

      case 'HANDSHAKE_ACK': {
        if (message.token === this.handshakeToken) {
          this.isHandshakeEstablished = true;
          console.log('[LamaniSync Isolated] Handshake established with MAIN world runner.');
        }
        break;
      }

      case 'OBSERVATION': {
        this.forwardObservationToServiceWorker(message.payload);
        showInPageSyncToast(message.payload);
        break;
      }

      case 'ACTION_RESULT': {
        const { correlationId } = message.payload;
        const pending = this.pendingActions.get(correlationId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingActions.delete(correlationId);
          pending.resolve(message.payload);
        }
        break;
      }
    }
  }

  private forwardObservationToServiceWorker(payload: unknown): void {
    if (!this.chromeRuntime?.sendMessage) return;

    this.chromeRuntime
      .sendMessage({
        type: 'CMS_OBSERVATION',
        payload,
      })
      .catch((err) => {
        console.warn('[LamaniSync Isolated] Failed to forward observation to service worker:', err);
      });
  }

  handleRuntimeMessage(message: unknown, sendResponse: (response?: unknown) => void): boolean | void {
    const msg = message as Record<string, unknown> | null | undefined;
    if (msg?.type === 'EXECUTE_PAGE_ACTION') {
      const actionId = msg.actionId as string;
      const parameters = (msg.parameters as Record<string, unknown>) || {};
      const correlationId = msg.correlationId as string | undefined;

      if (!isAllowlistedActionId(actionId)) {
        sendResponse({
          success: false,
          error: `Action ID '${actionId}' is not allowlisted (AGENTS.md Rule 8)`,
          code: 'UNSUPPORTED_ACTION_ID',
        });
        return false;
      }

      if (!this.isHandshakeEstablished) {
        sendResponse({
          success: false,
          error: 'Handshake with page-world runner is not established',
          code: 'HANDSHAKE_NOT_READY',
        });
        return false;
      }

      const activeCorrId = correlationId || ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `act-${Date.now()}`);

      this.executeActionInPage(actionId, activeCorrId, parameters)
        .then((result: unknown) => {
          const res = result as Record<string, unknown> | undefined;
          if (res && res.status === 'SUCCESS') {
            sendResponse({ success: true, result: res });
          } else {
            const errObj = res?.error as Record<string, unknown> | undefined;
            sendResponse({
              success: false,
              code: errObj?.code || res?.status || 'ACTION_FAILED',
              error: errObj?.message || `Action execution returned ${String(res?.status)}`,
              result: res,
            });
          }
        })
        .catch((err) => sendResponse({ success: false, error: err.message, code: err.code }));

      return true; // async response
    }

    if (msg?.type === 'GET_BRIDGE_STATUS') {
      sendResponse({
        ready: this.isHandshakeEstablished,
        origin: this.targetOrigin,
      });
      return false;
    }

    return false;
  }

  executeActionInPage(actionId: string, correlationId: string, parameters: Record<string, unknown>): Promise<unknown> {
    if (!this.isHandshakeEstablished) {
      return Promise.reject(new LamaniError('Handshake with page-world runner is not established', 'HANDSHAKE_NOT_READY'));
    }
    if (!this.targetOrigin || this.targetOrigin === '*') {
      return Promise.reject(new LamaniError('Target origin is not configured or is wildcard', 'INVALID_ORIGIN'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(correlationId);
        reject(new LamaniError(`Action execution timed out (${this.actionTimeoutMs}ms)`, 'ACTION_TIMEOUT'));
      }, this.actionTimeoutMs);

      this.pendingActions.set(correlationId, { resolve, reject, timer });

      const executeMsg = {
        channel: BRIDGE_CHANNEL,
        source: SOURCE_ISOLATED,
        token: this.handshakeToken,
        type: 'EXECUTE_ACTION',
        payload: {
          actionId,
          correlationId,
          parameters,
        },
      };

      this.targetWindow.postMessage(executeMsg, this.targetOrigin);
    });
  }
}

// Self-instantiate when running directly as a Chrome content script in browser
if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  const bridge = new IsolatedContentBridge();
  bridge.start();
}

export function showInPageSyncToast(payload: unknown): void {
  if (typeof document === 'undefined' || !document.body) return;
  try {
    let pill = document.getElementById('lamanisync-sync-indicator');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'lamanisync-sync-indicator';
      pill.style.cssText = [
        'position: fixed',
        'bottom: 24px',
        'right: 24px',
        'z-index: 2147483647',
        'background: rgba(15, 23, 42, 0.95)',
        'color: #f8fafc',
        'padding: 8px 14px',
        'border-radius: 9999px',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'font-size: 12px',
        'font-weight: 500',
        'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25)',
        'border: 1px solid rgba(255, 255, 255, 0.15)',
        'display: flex',
        'align-items: center',
        'gap: 8px',
        'pointer-events: none',
        'transition: opacity 0.25s ease, transform 0.25s ease',
        'opacity: 0',
        'transform: translateY(8px)',
        'backdrop-filter: blur(8px)',
      ].join('; ');
      document.body.appendChild(pill);
    }

    const payloadObj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
    const endpoint = typeof payloadObj?.endpoint === 'string' ? payloadObj.endpoint : '/sync';
    const cleanEndpoint = endpoint.split('?')[0];

    pill.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;"></span> LamaniSync: Synced ${cleanEndpoint}`;
    pill.style.opacity = '1';
    pill.style.transform = 'translateY(0)';

    const holder = pill as unknown as { _hideTimer?: ReturnType<typeof setTimeout> };
    if (holder._hideTimer) clearTimeout(holder._hideTimer);
    holder._hideTimer = setTimeout(() => {
      if (pill) {
        pill.style.opacity = '0';
        pill.style.transform = 'translateY(8px)';
      }
    }, 2200);
  } catch {
    // Non-fatal UI indicator fallback
  }
}

