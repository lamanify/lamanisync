/**
 * MAIN-World Runner Entry Point (Phase 5)
 * Runs in Chrome's MAIN execution world on document_start.
 * Listens for handshake initialization from the isolated content script,
 * activates the network observer, and executes allowlisted predefined actions.
 * Adheres strictly to AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, bearer tokens, or CSRF secrets.
 * Rule 8: Page-world code may execute only predefined adapter action IDs.
 */

import {
  BRIDGE_CHANNEL,
  SOURCE_ISOLATED,
  SOURCE_MAIN,
  validateIncomingPageMessage,
  type IsolatedToPageMessage,
} from '../content/page-message-validator.js';
import { installNetworkObserver, type NetworkObserverHandle } from './observer.js';
import { executePredefinedAction } from './action-runner.js';

export interface MainWorldRunnerOptions {
  targetWindow?: Window;
  targetOrigin?: string;
}

export class MainWorldRunner {
  private targetWindow: Window;
  private targetOrigin: string;
  private handshakeToken: string | null = null;
  private observerHandle: NetworkObserverHandle | null = null;
  private messageListener?: (event: MessageEvent) => void;

  constructor(options: MainWorldRunnerOptions = {}) {
    this.targetWindow = options.targetWindow || (typeof window !== 'undefined' ? window : ({} as Window));
    this.targetOrigin = options.targetOrigin || (this.targetWindow.location?.origin || '');
  }

  getHandshakeToken(): string | null {
    return this.handshakeToken;
  }

  start(): void {
    if (!this.targetWindow.addEventListener) return;

    this.messageListener = (event: MessageEvent) => this.handleMessage(event);
    this.targetWindow.addEventListener('message', this.messageListener);

    // Proactively request handshake in case isolated script was already loaded
    this.requestHandshake();
  }

  stop(): void {
    if (this.messageListener && this.targetWindow.removeEventListener) {
      this.targetWindow.removeEventListener('message', this.messageListener);
    }
    if (this.observerHandle) {
      this.observerHandle.uninstall();
      this.observerHandle = null;
    }
  }

  requestHandshake(): void {
    const nonce = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}`;
    const req = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_MAIN,
      type: 'HANDSHAKE_REQUEST',
      payload: { nonce },
    };
    this.targetWindow.postMessage(req, this.targetOrigin || '*');
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const result = validateIncomingPageMessage<IsolatedToPageMessage>({
      event: {
        origin: event.origin,
        source: event.source,
        data: event.data,
      },
      expectedOrigin: this.targetOrigin,
      handshakeToken: this.handshakeToken,
      expectedSource: SOURCE_ISOLATED,
      currentWindow: this.targetWindow,
    });

    if (!result.success) {
      return;
    }

    const message = result.message;

    if (message.type === 'HANDSHAKE_INIT') {
      this.handshakeToken = message.token;

      // Acknowledge handshake
      const ack = {
        channel: BRIDGE_CHANNEL,
        source: SOURCE_MAIN,
        token: this.handshakeToken,
        type: 'HANDSHAKE_ACK',
        payload: { acknowledged: true as const },
      };
      this.targetWindow.postMessage(ack, this.targetOrigin || '*');

      // Install or update network observer with verified handshake token
      if (!this.observerHandle) {
        this.observerHandle = installNetworkObserver({
          handshakeToken: this.handshakeToken,
          targetOrigin: this.targetOrigin,
          targetWindow: this.targetWindow,
        });
      } else {
        this.observerHandle.updateToken(this.handshakeToken);
      }
      return;
    }

    if (message.type === 'EXECUTE_ACTION') {
      const { actionId, correlationId, parameters } = message.payload;

      const actionResult = await executePredefinedAction({
        actionId,
        correlationId,
        parameters,
        fetchFn: this.targetWindow.fetch?.bind(this.targetWindow),
        baseOrigin: this.targetOrigin,
      });

      const responseMsg = {
        channel: BRIDGE_CHANNEL,
        source: SOURCE_MAIN,
        token: this.handshakeToken,
        type: 'ACTION_RESULT',
        payload: {
          actionId: actionResult.actionId,
          correlationId: actionResult.correlationId,
          status: actionResult.status,
          data: actionResult.data,
          error: actionResult.error,
        },
      };

      this.targetWindow.postMessage(responseMsg, this.targetOrigin || '*');
    }
  }
}

// Self-instantiate when running directly in browser MAIN world
if (typeof window !== 'undefined') {
  const runner = new MainWorldRunner();
  runner.start();
}
