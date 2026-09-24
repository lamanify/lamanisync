// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  validateIncomingPageMessage,
  BRIDGE_CHANNEL,
  SOURCE_MAIN,
  SOURCE_ISOLATED,
  type PageToIsolatedMessage,
} from '../../src/content/page-message-validator.js';

describe('Two-World Boundary & Message Validator (Phase 5)', () => {
  const origin = 'http://localhost:4001';
  const token = 'test-handshake-token-12345';

  it('successfully validates legitimate MAIN-world observation message', () => {
    const rawMsg = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_MAIN,
      token,
      type: 'OBSERVATION',
      payload: {
        endpoint: '/api/appointments',
        method: 'GET',
        statusCode: 200,
        data: [{ id: 'APT-001', startTime: '2026-09-25T09:00:00+08:00' }],
        timestamp: new Date().toISOString(),
      },
    };

    const result = validateIncomingPageMessage<PageToIsolatedMessage>({
      event: {
        origin,
        source: window,
        data: rawMsg,
      },
      expectedOrigin: origin,
      handshakeToken: token,
      expectedSource: SOURCE_MAIN,
    });

    expect(result.success).toBe(true);
    if (result.success && result.message.type === 'OBSERVATION') {
      expect(result.message.payload.endpoint).toBe('/api/appointments');
    }
  });

  it('rejects message from untrusted iframe (event.source !== window)', () => {
    const fakeIframeWindow = {} as Window;

    const rawMsg = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_MAIN,
      token,
      type: 'OBSERVATION',
      payload: {
        endpoint: '/api/appointments',
        method: 'GET',
        statusCode: 200,
        data: [],
        timestamp: new Date().toISOString(),
      },
    };

    const result = validateIncomingPageMessage({
      event: {
        origin,
        source: fakeIframeWindow,
        data: rawMsg,
      },
      expectedOrigin: origin,
      handshakeToken: token,
      currentWindow: window,
    });

    expect(result.success).toBe(false);
    if (!result.success && !result.ignored) {
      expect(result.error.code).toBe('UNTRUSTED_SOURCE');
      expect(result.diagnostic).toBeDefined();
      expect(result.diagnostic.errorType).toBe('UNTRUSTED_SOURCE');
    }
  });

  it('strictly rejects origin mismatch', () => {
    const rawMsg = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_MAIN,
      token,
      type: 'OBSERVATION',
      payload: {
        endpoint: '/api/appointments',
        method: 'GET',
        statusCode: 200,
        data: [],
        timestamp: new Date().toISOString(),
      },
    };

    const result = validateIncomingPageMessage({
      event: {
        origin: 'http://evil-origin.com',
        source: window,
        data: rawMsg,
      },
      expectedOrigin: origin,
      handshakeToken: token,
    });

    expect(result.success).toBe(false);
    if (!result.success && !result.ignored) {
      expect(result.error.code).toBe('ORIGIN_MISMATCH');
      expect(result.diagnostic.errorType).toBe('ORIGIN_MISMATCH');
    }
  });

  it('rejects forged or mismatched handshake tokens', () => {
    const rawMsg = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_MAIN,
      token: 'forged-token-xyz',
      type: 'OBSERVATION',
      payload: {
        endpoint: '/api/appointments',
        method: 'GET',
        statusCode: 200,
        data: [],
        timestamp: new Date().toISOString(),
      },
    };

    const result = validateIncomingPageMessage({
      event: {
        origin,
        source: window,
        data: rawMsg,
      },
      expectedOrigin: origin,
      handshakeToken: token, // expected token
    });

    expect(result.success).toBe(false);
    if (!result.success && !result.ignored) {
      expect(result.error.code).toBe('INVALID_HANDSHAKE_TOKEN');
      expect(result.diagnostic.errorType).toBe('INVALID_HANDSHAKE_TOKEN');
    }
  });

  it('rejects schema drift or malformed message structures', () => {
    const malformedMsg = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_MAIN,
      token,
      type: 'OBSERVATION',
      payload: {
        // Missing required endpoint and timestamp
        method: 'DELETE', // invalid method for observation
        statusCode: 'not-a-number',
      },
    };

    const result = validateIncomingPageMessage({
      event: {
        origin,
        source: window,
        data: malformedMsg,
      },
      expectedOrigin: origin,
      handshakeToken: token,
    });

    expect(result.success).toBe(false);
    if (!result.success && !result.ignored) {
      expect(result.error.code).toBe('SCHEMA_VALIDATION_FAILED');
      expect(result.diagnostic.errorType).toBe('SCHEMA_VALIDATION_FAILED');
    }
  });

  it('safely ignores non-bridge window messages', () => {
    const nonBridgeMsg = {
      type: 'OTHER_APP_EVENT',
      payload: { foo: 'bar' },
    };

    const result = validateIncomingPageMessage({
      event: {
        origin,
        source: window,
        data: nonBridgeMsg,
      },
      expectedOrigin: origin,
      handshakeToken: token,
    });

    expect(result.success).toBe(false);
    expect(result.ignored).toBe(true);
  });

  it('validates ISOLATED -> MAIN execute action message', () => {
    const rawMsg = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_ISOLATED,
      token,
      type: 'EXECUTE_ACTION',
      payload: {
        actionId: 'ACTION_APPOINTMENT_CREATE',
        correlationId: 'cmd-12345',
        parameters: { patientId: 'P01', providerId: 'DOC01' },
      },
    };

    const result = validateIncomingPageMessage({
      event: {
        origin,
        source: window,
        data: rawMsg,
      },
      expectedOrigin: origin,
      handshakeToken: token,
      expectedSource: SOURCE_ISOLATED,
    });

    expect(result.success).toBe(true);
  });

  it('validates observation endpoint containing PostgREST query characters (*, (), +, commas)', () => {
    const rawMsg = {
      channel: BRIDGE_CHANNEL,
      source: SOURCE_MAIN,
      token,
      type: 'OBSERVATION',
      payload: {
        endpoint: '/rest/v1/patients?phone=eq.+60123456789&select=id,full_name,created_at(date)&start_time=gte.2026-10-01T09:00:00+08:00',
        method: 'GET',
        statusCode: 200,
        data: [{ id: 'PAT-01' }],
        timestamp: new Date().toISOString(),
      },
    };

    const result = validateIncomingPageMessage<PageToIsolatedMessage>({
      event: {
        origin,
        source: window,
        data: rawMsg,
      },
      expectedOrigin: origin,
      handshakeToken: token,
      expectedSource: SOURCE_MAIN,
    });

    expect(result.success).toBe(true);
  });
});
