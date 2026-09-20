// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installNetworkObserver,
  stripAuthSecrets,
  sanitizeUrlPath,
  isAllowlistedObservationPath,
} from '../../src/page/observer.js';

describe('MAIN-World Network Observer (Phase 5)', () => {
  const origin = 'http://localhost:4001';
  const token = 'handshake-token-obs-123';
  let observerHandle: { uninstall: () => void } | null = null;
  let emittedEvents: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    emittedEvents = [];
    // Set window origin
    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost:4001/'),
      writable: true,
    });
  });

  afterEach(() => {
    if (observerHandle) {
      observerHandle.uninstall();
      observerHandle = null;
    }
    vi.restoreAllMocks();
  });

  describe('Path Allowlist & Sanitization', () => {
    it('correctly matches allowlisted CMS endpoints', () => {
      expect(isAllowlistedObservationPath('/api/appointments')).toBe(true);
      expect(isAllowlistedObservationPath('/api/appointments/APT-001')).toBe(true);
      expect(isAllowlistedObservationPath('/api/patients')).toBe(true);
      expect(isAllowlistedObservationPath('/api/patients/P01')).toBe(true);
      expect(isAllowlistedObservationPath('/api/reference/providers')).toBe(true);
      expect(isAllowlistedObservationPath('/api/reference/services')).toBe(true);
    });

    it('rejects non-allowlisted and auth endpoints', () => {
      expect(isAllowlistedObservationPath('/api/auth/login')).toBe(false);
      expect(isAllowlistedObservationPath('/api/auth/session')).toBe(false);
      expect(isAllowlistedObservationPath('/api/admin/users')).toBe(false);
      expect(isAllowlistedObservationPath('/other/path')).toBe(false);
    });

    it('sanitizes URL query parameters by stripping sensitive tokens and secrets', () => {
      const raw = '/api/appointments?date=2026-09-25&token=secret123&session_token=abc&status=booked';
      const clean = sanitizeUrlPath(raw, origin);
      expect(clean).toBe('/api/appointments?date=2026-09-25&status=booked');
      expect(clean).not.toContain('secret123');
      expect(clean).not.toContain('session_token');
    });

    it('recursively strips auth secrets and session cookies from response data (Rule 4)', () => {
      const dirtyData = {
        id: 'APT-100',
        patientId: 'P-01',
        token: 'leak-token-123',
        sessionToken: 'leak-session-token',
        cms_session: 'cookie-val',
        csrf_token: 'csrf-xyz',
        staff: {
          name: 'Dr. John',
          password: 'supersecretpass',
          apiKey: 'key-999',
        },
        items: [
          { code: 'A1', bearer: 'bearer-val' },
          { code: 'A2', note: 'normal note' },
        ],
      };

      interface CleanData {
        id: string;
        patientId: string;
        token?: string;
        sessionToken?: string;
        cms_session?: string;
        csrf_token?: string;
        staff: { name: string; password?: string; apiKey?: string };
        items: Array<{ code: string; bearer?: string; note?: string }>;
      }

      const clean = stripAuthSecrets(dirtyData) as unknown as CleanData;

      expect(clean.id).toBe('APT-100');
      expect(clean.patientId).toBe('P-01');
      expect(clean.token).toBeUndefined();
      expect(clean.sessionToken).toBeUndefined();
      expect(clean.cms_session).toBeUndefined();
      expect(clean.csrf_token).toBeUndefined();
      expect(clean.staff.password).toBeUndefined();
      expect(clean.staff.apiKey).toBeUndefined();
      expect(clean.staff.name).toBe('Dr. John');
      expect(clean.items[0].bearer).toBeUndefined();
      expect(clean.items[1].note).toBe('normal note');
    });
  });

  describe('Fetch Interception and Event Emission', () => {
    it('intercepts allowlisted GET /api/appointments and emits sanitized observation', async () => {
      const mockData = {
        data: [{ id: 'APT-001', startTime: '2026-09-25T10:00:00+08:00' }],
        token: 'must-be-stripped',
      };

      window.fetch = vi.fn(async () => {
        return new Response(JSON.stringify(mockData), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'cms_session=sensitive_cookie; Path=/',
          },
        });
      });

      observerHandle = installNetworkObserver({
        handshakeToken: token,
        targetOrigin: origin,
        onObservation: (obs) => emittedEvents.push(obs as Record<string, unknown>),
      });

      const res = await window.fetch('http://localhost:4001/api/appointments');
      const json = await res.json();

      // Original caller receives untampered response body
      expect(json.data[0].id).toBe('APT-001');

      // Emitted observation event has been sanitized
      expect(emittedEvents).toHaveLength(1);
      const obs = emittedEvents[0] as {
        type: string;
        token: string;
        payload: {
          endpoint: string;
          data: { data: Array<{ id: string }>; token?: string };
          headers?: unknown;
        };
      };
      expect(obs.type).toBe('OBSERVATION');
      expect(obs.token).toBe(token);
      expect(obs.payload.endpoint).toBe('/api/appointments');
      expect(obs.payload.data.data[0].id).toBe('APT-001');
      expect(obs.payload.data.token).toBeUndefined();
      // Observation event has zero headers
      expect(obs.payload.headers).toBeUndefined();
    });

    it('does not observe non-allowlisted endpoints like /api/auth/session', async () => {
      window.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ authenticated: true, staff: { id: 'S1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      observerHandle = installNetworkObserver({
        handshakeToken: token,
        targetOrigin: origin,
        onObservation: (obs) => emittedEvents.push(obs as Record<string, unknown>),
      });

      await window.fetch('http://localhost:4001/api/auth/session');
      expect(emittedEvents).toHaveLength(0);
    });

    it('does not observe POST requests initiated with Request object', async () => {
      window.fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ data: { id: 'APT-CREATED' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      observerHandle = installNetworkObserver({
        handshakeToken: token,
        targetOrigin: origin,
        onObservation: (obs) => emittedEvents.push(obs as Record<string, unknown>),
      });

      const req = new Request('http://localhost:4001/api/appointments', {
        method: 'POST',
        body: JSON.stringify({ patientId: 'P1' }),
      });

      await window.fetch(req);
      expect(emittedEvents).toHaveLength(0);
    });

    it('handles 204 No Content safely without attempting to parse JSON', async () => {
      window.fetch = vi.fn(async () => {
        return new Response(null, {
          status: 204,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      observerHandle = installNetworkObserver({
        handshakeToken: token,
        targetOrigin: origin,
        onObservation: (obs) => emittedEvents.push(obs as Record<string, unknown>),
      });

      await window.fetch('http://localhost:4001/api/appointments');
      expect(emittedEvents).toHaveLength(0);
    });

    it('intercepts allowlisted GET /api/appointments via XMLHttpRequest', () => {
      // Mock the underlying native send to avoid real network call in JSDOM unit test
      const nativeSend = window.XMLHttpRequest.prototype.send;
      window.XMLHttpRequest.prototype.send = vi.fn();

      try {
        observerHandle = installNetworkObserver({
          handshakeToken: token,
          targetOrigin: origin,
          onObservation: (obs) => emittedEvents.push(obs as Record<string, unknown>),
        });

        const xhr = new window.XMLHttpRequest();
        xhr.open('GET', 'http://localhost:4001/api/appointments');

        Object.defineProperty(xhr, 'status', { value: 200 });
        Object.defineProperty(xhr, 'responseText', {
          value: JSON.stringify({ data: [{ id: 'APT-XHR-1' }], token: 'secret-xhr' }),
        });
        xhr.getResponseHeader = (header: string) => (header.toLowerCase() === 'content-type' ? 'application/json' : null);

        xhr.send();
        xhr.dispatchEvent(new Event('load'));

        expect(emittedEvents).toHaveLength(1);
        const obs = emittedEvents[0] as {
          payload: {
            endpoint: string;
            data: { data: Array<{ id: string }>; token?: string };
          };
        };
        expect(obs.payload.endpoint).toBe('/api/appointments');
        expect(obs.payload.data.data[0].id).toBe('APT-XHR-1');
        expect(obs.payload.data.token).toBeUndefined();
      } finally {
        window.XMLHttpRequest.prototype.send = nativeSend;
      }
    });

    it('uninstalls cleanly and stops observing', async () => {
      const original = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      window.fetch = original;

      observerHandle = installNetworkObserver({
        handshakeToken: token,
        targetOrigin: origin,
        onObservation: (obs) => emittedEvents.push(obs as Record<string, unknown>),
      });

      observerHandle.uninstall();
      observerHandle = null;

      expect(window.fetch).toBe(original);
    });
  });
});
