// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  normalizeExactOrigin,
  toExactOriginPattern,
  validateOriginMatch,
  requestOriginPermission,
  hasOriginPermission,
  removeOriginPermission,
  type ChromePermissionsApi,
} from '../../src/background/permissions.js';
import { LamaniError } from '../../src/core/errors.js';

describe('Permissions Manager (Exact CMS Origin)', () => {
  describe('normalizeExactOrigin & toExactOriginPattern', () => {
    it('normalizes valid exact http and https origins', () => {
      expect(normalizeExactOrigin('http://localhost:4001')).toBe('http://localhost:4001');
      expect(normalizeExactOrigin('http://localhost:4001/')).toBe('http://localhost:4001');
      expect(normalizeExactOrigin('https://clinic.example.com')).toBe('https://clinic.example.com');
      expect(normalizeExactOrigin('https://clinic.example.com/')).toBe('https://clinic.example.com');

      expect(toExactOriginPattern('http://localhost:4001')).toBe('http://localhost:4001/*');
      expect(toExactOriginPattern('https://clinic.example.com')).toBe('https://clinic.example.com/*');
    });

    it('strictly rejects wildcard origins (AGENTS.md Rule 3)', () => {
      expect(() => normalizeExactOrigin('*://*/*')).toThrow(LamaniError);
      expect(() => normalizeExactOrigin('https://*/*')).toThrow(LamaniError);
      expect(() => normalizeExactOrigin('http://*/*')).toThrow(LamaniError);
      expect(() => normalizeExactOrigin('https://*.example.com')).toThrow(LamaniError);
      expect(() => normalizeExactOrigin('http://localhost:*')).toThrow(LamaniError);

      try {
        normalizeExactOrigin('https://*/*');
      } catch (err) {
        expect((err as LamaniError).code).toBe('BROAD_PERMISSION_REJECTED');
      }
    });

    it('rejects origins with paths, queries, fragments, or credentials', () => {
      // Path
      expect(() => normalizeExactOrigin('http://localhost:4001/api')).toThrow();
      // Query
      expect(() => normalizeExactOrigin('http://localhost:4001?foo=bar')).toThrow();
      // Hash
      expect(() => normalizeExactOrigin('http://localhost:4001#hash')).toThrow();
      // Credentials
      expect(() => normalizeExactOrigin('http://user:pass@localhost:4001')).toThrow();
      // Non http/https
      expect(() => normalizeExactOrigin('ftp://localhost:4001')).toThrow();
      // Empty / invalid
      expect(() => normalizeExactOrigin('')).toThrow();
    });
  });

  describe('validateOriginMatch', () => {
    it('passes when requested origin matches expected origin exactly', () => {
      expect(() =>
        validateOriginMatch('http://localhost:4001', 'http://localhost:4001')
      ).not.toThrow();
      expect(() =>
        validateOriginMatch('http://localhost:4001/', 'http://localhost:4001')
      ).not.toThrow();
    });

    it('fails closed when origins do not match', () => {
      expect(() =>
        validateOriginMatch('http://localhost:4002', 'http://localhost:4001')
      ).toThrow(LamaniError);

      try {
        validateOriginMatch('https://evil.com', 'http://localhost:4001');
      } catch (err) {
        expect((err as LamaniError).code).toBe('ORIGIN_MISMATCH');
        expect((err as LamaniError).statusCode).toBe(403);
      }
    });
  });

  describe('Browser Permission Invocations', () => {
    it('requests exact origin pattern via chrome.permissions.request on user gesture', async () => {
      const mockApi: ChromePermissionsApi = {
        request: vi.fn().mockResolvedValue(true),
        contains: vi.fn().mockResolvedValue(false),
        remove: vi.fn().mockResolvedValue(true),
      };

      const granted = await requestOriginPermission('http://localhost:4001', 'http://localhost:4001', mockApi);
      expect(granted).toBe(true);
      expect(mockApi.request).toHaveBeenCalledWith({
        origins: ['http://localhost:4001/*'],
      });
    });

    it('checks permission presence via chrome.permissions.contains', async () => {
      const mockApi: ChromePermissionsApi = {
        request: vi.fn().mockResolvedValue(true),
        contains: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
      };

      const hasPerm = await hasOriginPermission('http://localhost:4001', mockApi);
      expect(hasPerm).toBe(true);
      expect(mockApi.contains).toHaveBeenCalledWith({
        origins: ['http://localhost:4001/*'],
      });
    });

    it('removes exact origin permission on unpair', async () => {
      const mockApi: ChromePermissionsApi = {
        request: vi.fn().mockResolvedValue(true),
        contains: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
      };

      const removed = await removeOriginPermission('http://localhost:4001', mockApi);
      expect(removed).toBe(true);
      expect(mockApi.remove).toHaveBeenCalledWith({
        origins: ['http://localhost:4001/*'],
      });
    });
  });
});
