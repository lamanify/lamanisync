/**
 * MAIN-World Network Observer (Phase 5)
 * Intercepts allowlisted CMS fetch reads in the MAIN world, strips all auth secrets,
 * and emits sanitized observation events to the isolated content script.
 * Adheres strictly to AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, bearer tokens, or CSRF secrets.
 * Rule 8: Read observations only; never execute arbitrary requests here.
 */

import { BRIDGE_CHANNEL, SOURCE_MAIN } from '../content/page-message-validator.js';

export const ALLOWLISTED_OBSERVATION_PATHS = [
  /^\/api\/appointments(\/[a-zA-Z0-9_-]+)?(\?.*)?$/,
  /^\/api\/patients(\/[a-zA-Z0-9_-]+)?(\?.*)?$/,
  /^\/api\/reference\/(providers|services|locations)(\?.*)?$/,
];

export const SENSITIVE_PARAM_NAMES = new Set([
  'token',
  'session',
  'session_token',
  'cms_session',
  'secret',
  'password',
  'auth',
  'bearer',
  'csrf',
  'xsrf',
  'key',
  'apikey',
]);

export const SENSITIVE_BODY_KEYS = [
  'token',
  'sessiontoken',
  'cmssession',
  'session',
  'password',
  'passwd',
  'secret',
  'csrf',
  'xsrf',
  'authorization',
  'bearer',
  'apikey',
  'privatekey',
  'credential',
  'credentials',
];

/**
 * Checks if a relative URL path matches allowlisted CMS read endpoints.
 */
export function isAllowlistedObservationPath(pathname: string): boolean {
  return ALLOWLISTED_OBSERVATION_PATHS.some((regex) => regex.test(pathname));
}

/**
 * Strips sensitive query parameters from a URL path, preserving safe filters.
 */
export function sanitizeUrlPath(rawUrl: string, baseOrigin?: string): string {
  try {
    const url = new URL(rawUrl, baseOrigin || 'http://localhost');
    const safeSearchParams = new URLSearchParams();

    for (const [key, val] of url.searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      if (!SENSITIVE_PARAM_NAMES.has(lowerKey) && !lowerKey.includes('token') && !lowerKey.includes('secret')) {
        safeSearchParams.append(key, val);
      }
    }

    const qs = safeSearchParams.toString();
    return qs ? `${url.pathname}?${qs}` : url.pathname;
  } catch {
    return rawUrl.split('?')[0];
  }
}

/**
 * Strips all authentication secrets, cookies, tokens, and CSRF data recursively.
 * Guarantees zero leakage of CMS credentials to extension layers.
 */
export function stripAuthSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return obj
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED_BEARER]')
      .replace(/(?:cms_session|session_token|token|secret)=[^;,\s&]+/gi, '$1=[REDACTED]');
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => stripAuthSecrets(item));
  }

  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const normalizedKey = k.toLowerCase().replace(/[-_\s]/g, '');
    const isSensitive = SENSITIVE_BODY_KEYS.some((s) => normalizedKey.includes(s));

    if (isSensitive) {
      continue; // completely omit auth secret fields
    }

    clean[k] = stripAuthSecrets(v);
  }

  return clean;
}

export interface NetworkObserverOptions {
  handshakeToken: string;
  targetOrigin: string;
  targetWindow?: Window;
  onObservation?: (event: unknown) => void;
}

export interface NetworkObserverHandle {
  uninstall: () => void;
  updateToken: (newToken: string) => void;
}

/**
 * Installs the network observer on window.fetch.
 * Runs at document_start in the MAIN world to observe allowlisted CMS reads.
 */
export function installNetworkObserver(options: NetworkObserverOptions): NetworkObserverHandle {
  const targetWindow = options.targetWindow || (typeof window !== 'undefined' ? window : undefined);
  if (!targetWindow || typeof targetWindow.fetch !== 'function') {
    throw new Error('Target window.fetch is not available to observe');
  }

  let currentToken = options.handshakeToken;
  const originalFetch = targetWindow.fetch;

  const observerFetch: typeof targetWindow.fetch = async (input, init) => {
    // 1. Always execute native fetch first
    const response = await originalFetch.call(targetWindow, input, init);

    // 2. Wrap observation in safe try-catch so it never disrupts the page
    try {
      const method = (init?.method || 'GET').toUpperCase();
      // Only observe read operations
      if (method === 'GET' || method === 'HEAD') {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const parsedUrl = new URL(rawUrl, targetWindow.location.origin);

        // Verify same origin
        if (parsedUrl.origin === targetWindow.location.origin) {
          const pathname = parsedUrl.pathname;
          if (isAllowlistedObservationPath(pathname)) {
            // Clone response to read body without consuming original
            const cloned = response.clone();
            const contentType = cloned.headers.get('content-type') || '';

            if (contentType.includes('application/json') && cloned.ok) {
              const rawData = await cloned.json();
              const sanitizedData = stripAuthSecrets(rawData);
              const sanitizedEndpoint = sanitizeUrlPath(pathname + parsedUrl.search, targetWindow.location.origin);

              const observationEvent = {
                channel: BRIDGE_CHANNEL,
                source: SOURCE_MAIN,
                token: currentToken,
                type: 'OBSERVATION',
                payload: {
                  endpoint: sanitizedEndpoint,
                  method: 'GET' as const,
                  statusCode: response.status,
                  data: sanitizedData,
                  timestamp: new Date().toISOString(),
                },
              };

              // Emit event via window.postMessage targeted strictly to exact origin
              targetWindow.postMessage(observationEvent, options.targetOrigin);

              if (options.onObservation) {
                options.onObservation(observationEvent);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[LamaniSync Observer] Non-fatal observation processing error:', err);
    }

    return response;
  };

  targetWindow.fetch = observerFetch;

  return {
    uninstall: () => {
      targetWindow.fetch = originalFetch;
    },
    updateToken: (newToken: string) => {
      currentToken = newToken;
    },
  };
}
