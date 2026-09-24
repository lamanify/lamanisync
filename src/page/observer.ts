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
  /^\/rest\/v1\/(patients|appointments|profiles|medical_services|clinic_settings)(\?.*)?$/,
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
  'cookie',
  'cookies',
  'sessionid',
  'jwt',
  'code',
  'sig',
  'signature',
  'auth_token',
  'authorization',
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
      .replace(/(?:cms_session|session_token|token|secret|jwt|cookie|auth|bearer|csrf|xsrf)=[^;,\s&]+/gi, '$1=[REDACTED]');
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date || obj instanceof RegExp) {
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

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/$/, '');
  }
}

function matchOriginPattern(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(origin);
  }
  return false;
}

export function isPermittedObservationOrigin(
  urlOrigin: string,
  pageOrigin: string,
  allowedOrigins?: string[],
  adapterOrigin?: string
): boolean {
  const normUrl = normalizeOrigin(urlOrigin);
  const normPage = normalizeOrigin(pageOrigin);
  if (normUrl === normPage) return true;
  if (adapterOrigin) {
    const normAdapter = normalizeOrigin(adapterOrigin);
    if (normUrl === normAdapter || matchOriginPattern(adapterOrigin, normUrl)) return true;
  }
  if (allowedOrigins && allowedOrigins.length > 0) {
    for (const pat of allowedOrigins) {
      const normPat = normalizeOrigin(pat);
      if (normPat === normUrl || matchOriginPattern(pat, normUrl)) {
        return true;
      }
    }
  }
  // Allow PostgREST / Supabase hosted backends (e.g. *.supabase.co)
  if (/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(normUrl)) {
    return true;
  }
  return false;
}

export interface NetworkObserverOptions {
  handshakeToken: string;
  targetOrigin: string;
  targetWindow?: Window;
  onObservation?: (event: unknown) => void;
  allowedApiOrigins?: string[];
  adapterApiOrigin?: string;
}

export interface NetworkObserverHandle {
  uninstall: () => void;
  updateToken: (newToken: string) => void;
}

/**
 * Installs the network observer on window.fetch and window.XMLHttpRequest.
 * Runs at document_start in the MAIN world to observe allowlisted CMS reads.
 */
export function installNetworkObserver(options: NetworkObserverOptions): NetworkObserverHandle {
  const targetWindow = options.targetWindow || (typeof window !== 'undefined' ? window : undefined);
  if (!targetWindow) {
    throw new Error('Target window is not available to observe');
  }

  let currentToken = options.handshakeToken;

  const emitObservation = (endpoint: string, statusCode: number, rawData: unknown) => {
    try {
      const sanitizedData = stripAuthSecrets(rawData);
      const observationEvent = {
        channel: BRIDGE_CHANNEL,
        source: SOURCE_MAIN,
        token: currentToken,
        type: 'OBSERVATION',
        payload: {
          endpoint,
          method: 'GET' as const,
          statusCode,
          data: sanitizedData,
          timestamp: new Date().toISOString(),
        },
      };

      targetWindow.postMessage(observationEvent, options.targetOrigin);

      if (options.onObservation) {
        options.onObservation(observationEvent);
      }
    } catch (err) {
      console.warn('[LamaniSync Observer] Non-fatal observation event emission error:', err);
    }
  };

  // --- 1. Patch window.fetch ---
  let originalFetch: typeof targetWindow.fetch | undefined;
  if (typeof targetWindow.fetch === 'function') {
    originalFetch = targetWindow.fetch;

    const observerFetch: typeof targetWindow.fetch = async (input, init) => {
      const response = await originalFetch!.call(targetWindow, input, init);

      try {
        const rawMethod = init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : undefined) || 'GET';
        const method = rawMethod.toUpperCase();

        if (method === 'GET' || method === 'HEAD') {
          const rawUrl = typeof input === 'string'
            ? input
            : (typeof URL !== 'undefined' && input instanceof URL)
              ? input.toString()
              : (typeof Request !== 'undefined' && input instanceof Request)
                ? input.url
                : String(input);

          const parsedUrl = new URL(rawUrl, targetWindow.location.origin);

          if (isPermittedObservationOrigin(parsedUrl.origin, targetWindow.location.origin, options.allowedApiOrigins, options.adapterApiOrigin)) {
            const pathname = parsedUrl.pathname;
            if (isAllowlistedObservationPath(pathname)) {
              const cloned = response.clone();
              const contentType = cloned.headers.get('content-type') || '';

              if (cloned.status !== 204 && cloned.status !== 205 && contentType.includes('application/json') && cloned.ok) {
                const rawData = await cloned.json();
                const sanitizedEndpoint = sanitizeUrlPath(pathname + parsedUrl.search, targetWindow.location.origin);
                console.log('[LamaniSync Observer] Intercepted CMS read:', sanitizedEndpoint);
                emitObservation(sanitizedEndpoint, response.status, rawData);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[LamaniSync Observer] Non-fatal fetch observation processing error:', err);
      }

      return response;
    };

    targetWindow.fetch = observerFetch;
  }

  // --- 2. Patch window.XMLHttpRequest ---
  const winWithXhr = targetWindow as Window & { XMLHttpRequest?: typeof XMLHttpRequest };
  let originalXhrOpen: typeof XMLHttpRequest.prototype.open | undefined;
  let originalXhrSend: typeof XMLHttpRequest.prototype.send | undefined;

  if (winWithXhr.XMLHttpRequest && winWithXhr.XMLHttpRequest.prototype) {
    const xhrProto = winWithXhr.XMLHttpRequest.prototype;
    originalXhrOpen = xhrProto.open;
    originalXhrSend = xhrProto.send;

    xhrProto.open = function (
      this: XMLHttpRequest & { _lamaniMethod?: string; _lamaniUrl?: string },
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null
    ) {
      try {
        this._lamaniMethod = (method || 'GET').toUpperCase();
        this._lamaniUrl = typeof url === 'string' ? url : url.toString();
      } catch {
        // non-fatal
      }
      return originalXhrOpen!.call(this, method, url, async !== undefined ? async : true, username, password);
    };

    xhrProto.send = function (
      this: XMLHttpRequest & { _lamaniMethod?: string; _lamaniUrl?: string },
      body?: Document | XMLHttpRequestBodyInit | null
    ) {
      this.addEventListener('load', () => {
        try {
          const method = this._lamaniMethod || 'GET';
          if ((method === 'GET' || method === 'HEAD') && this.status >= 200 && this.status < 300) {
            const rawUrl = this._lamaniUrl || '';
            const parsedUrl = new URL(rawUrl, targetWindow.location.origin);

            if (isPermittedObservationOrigin(parsedUrl.origin, targetWindow.location.origin, options.allowedApiOrigins, options.adapterApiOrigin)) {
              const pathname = parsedUrl.pathname;
              if (isAllowlistedObservationPath(pathname)) {
                const contentType = this.getResponseHeader('content-type') || '';
                if (contentType.includes('application/json') && this.responseText) {
                  const rawData = JSON.parse(this.responseText);
                  const sanitizedEndpoint = sanitizeUrlPath(pathname + parsedUrl.search, targetWindow.location.origin);
                  emitObservation(sanitizedEndpoint, this.status, rawData);
                }
              }
            }
          }
        } catch (err) {
          console.warn('[LamaniSync Observer] Non-fatal XHR observation processing error:', err);
        }
      });

      return originalXhrSend!.call(this, body as XMLHttpRequestBodyInit | null | undefined);
    };
  }

  return {
    uninstall: () => {
      if (originalFetch && targetWindow.fetch) {
        targetWindow.fetch = originalFetch;
      }
      if (originalXhrOpen && originalXhrSend && winWithXhr.XMLHttpRequest?.prototype) {
        winWithXhr.XMLHttpRequest.prototype.open = originalXhrOpen;
        winWithXhr.XMLHttpRequest.prototype.send = originalXhrSend;
      }
    },
    updateToken: (newToken: string) => {
      currentToken = newToken;
    },
  };
}
