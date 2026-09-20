// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isPackagedHookRegistered,
  executePackagedHook,
  acmeExtractCsrf,
  acmeFormatDisplayTime,
} from '../../src/adapters/packaged-hooks/index.js';
import { LamaniError } from '../../src/core/errors.js';

describe('Packaged Hooks Registry & Execution (Phase 6)', () => {
  it('correctly registers allowlisted hooks and checks membership', () => {
    expect(isPackagedHookRegistered('acme-extract-csrf')).toBe(true);
    expect(isPackagedHookRegistered('acme-format-display-time')).toBe(true);
    expect(isPackagedHookRegistered('arbitrary-hook')).toBe(false);
  });

  it('rejects un-registered hook execution immediately', async () => {
    await expect(executePackagedHook('arbitrary-hook')).rejects.toThrowError(LamaniError);
    await expect(executePackagedHook('arbitrary-hook')).rejects.toMatchObject({
      code: 'UNKNOWN_HOOK',
    });
  });

  it('extracts CSRF token from cookie string', () => {
    const token = acmeExtractCsrf({
      cookieString: 'session_id=123; cms_csrf=secret-csrf-token-99; other=xyz',
    });
    expect(token).toBe('secret-csrf-token-99');
  });

  it('extracts CSRF token from mock document meta tag', () => {
    const mockDocument = {
      querySelector: (selector: string) => {
        if (selector === 'meta[name="csrf-token"]') {
          return { getAttribute: (attr: string) => (attr === 'content' ? 'meta-csrf-token-123' : null) };
        }
        return null;
      },
    } as unknown as Document;

    const token = acmeExtractCsrf({ document: mockDocument });
    expect(token).toBe('meta-csrf-token-123');
  });

  it('extracts CSRF token and sets context.headers header', () => {
    const headers: Record<string, string> = {};
    const token = acmeExtractCsrf({
      cookieString: 'session_id=123; cms_csrf=secret-csrf-token-99; other=xyz',
      headers,
    });
    expect(token).toBe('secret-csrf-token-99');
    expect(headers['X-CSRF-Token']).toBe('secret-csrf-token-99');
  });

  it('formats display time for ACME appointments and populates context.params.displayTime', () => {
    const params = { startTime: '2026-10-01T09:30:00+08:00' } as Record<string, unknown>;
    const formatted = acmeFormatDisplayTime({ params });
    expect(formatted).toBe('01/10/2026 09:30 AM');
    expect(params.displayTime).toBe('01/10/2026 09:30 AM');
  });
});
