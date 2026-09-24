// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isProductionDomain,
  validateSyncApiUrl,
  getSyncApiUrl,
  DEFAULT_DEV_SYNC_API_URL,
  DEFAULT_PROD_SYNC_API_URL,
} from '../../src/config/env.js';
import { LamaniError } from '../../src/core/errors.js';

describe('Environment Configuration & Production Domain Guard (Phase 10)', () => {
  describe('isProductionDomain', () => {
    it('identifies production hostnames correctly', () => {
      expect(isProductionDomain('app.lamani.my')).toBe(true);
      expect(isProductionDomain('api.lamani.my')).toBe(true);
      expect(isProductionDomain('sync.lamani.my')).toBe(true);
      expect(isProductionDomain('lamani.my')).toBe(true);
      expect(isProductionDomain('api.lamanihub.com')).toBe(true);
      expect(isProductionDomain('app.lamanihub.com')).toBe(true);
      expect(isProductionDomain('lamanihub.com')).toBe(true);
      expect(isProductionDomain('https://app.lamani.my/v1/sync')).toBe(true);
      expect(isProductionDomain('https://api.lamanihub.com')).toBe(true);
      expect(isProductionDomain('app.lamani.my:443')).toBe(true);
      expect(isProductionDomain('api.lamanihub.com:8443')).toBe(true);
    });

    it('permits staging, dev, demo, and localhost domains', () => {
      expect(isProductionDomain('localhost')).toBe(false);
      expect(isProductionDomain('127.0.0.1')).toBe(false);
      expect(isProductionDomain('http://localhost:4002')).toBe(false);
      expect(isProductionDomain('staging-api.lamani.my')).toBe(false);
      expect(isProductionDomain('staging.lamanihub.com')).toBe(false);
      expect(isProductionDomain('sync-staging.lamanihub.com')).toBe(false);
      expect(isProductionDomain('dev-api.lamanihub.com')).toBe(false);
      expect(isProductionDomain('demo.lamani.my')).toBe(false);
    });
  });

  describe('validateSyncApiUrl', () => {
    it('returns normalized origin for valid development endpoints', () => {
      expect(validateSyncApiUrl('http://localhost:4002/v1/sync', true)).toBe('http://localhost:4002');
      expect(validateSyncApiUrl('https://staging-api.lamani.my', true)).toBe('https://staging-api.lamani.my');
      expect(validateSyncApiUrl('https://staging.lamanihub.com/api', true)).toBe('https://staging.lamanihub.com');
    });

    it('strictly throws PROD_ENDPOINT_PROHIBITED when dev build points to production', () => {
      const prodUrls = [
        'https://app.lamani.my',
        'https://api.lamanihub.com',
        'https://sync.lamani.my',
        'https://lamanihub.com',
      ];

      for (const url of prodUrls) {
        expect(() => validateSyncApiUrl(url, true)).toThrowError(
          expect.objectContaining({
            name: 'LamaniError',
            code: 'PROD_ENDPOINT_PROHIBITED',
            statusCode: 403,
          })
        );
      }
    });

    it('allows production URL if isDev is false', () => {
      expect(validateSyncApiUrl('https://api.lamanihub.com', false)).toBe('https://api.lamanihub.com');
    });

    it('allows production URL if allowProdSync is true even in dev mode', () => {
      expect(validateSyncApiUrl('https://app.lamanihub.com', true, true)).toBe('https://app.lamanihub.com');
    });

    it('rejects invalid or non-HTTP protocols', () => {
      expect(() => validateSyncApiUrl('ftp://localhost:4002', true)).toThrow(LamaniError);
      expect(() => validateSyncApiUrl('javascript:alert(1)', true)).toThrow(LamaniError);
      expect(() => validateSyncApiUrl('not-a-url', true)).toThrow(LamaniError);
      expect(() => validateSyncApiUrl('', true)).toThrow(LamaniError);
    });
  });

  describe('getSyncApiUrl', () => {
    it('defaults to http://localhost:4002 when no env is provided in dev mode', () => {
      const url = getSyncApiUrl({ DEV: true });
      expect(url).toBe(DEFAULT_DEV_SYNC_API_URL);
    });

    it('defaults to https://app.lamanihub.com when in production mode', () => {
      const url = getSyncApiUrl({ DEV: false });
      expect(url).toBe(DEFAULT_PROD_SYNC_API_URL);
    });

    it('accepts staging URL override in dev mode', () => {
      const url = getSyncApiUrl({
        VITE_SYNC_API_URL: 'https://staging-api.lamani.my',
        DEV: true,
      });
      expect(url).toBe('https://staging-api.lamani.my');
    });

    it('prohibits production URL override in dev mode without allowProdSync', () => {
      expect(() =>
        getSyncApiUrl({
          VITE_SYNC_API_URL: 'https://app.lamani.my',
          DEV: true,
        })
      ).toThrow(LamaniError);
    });

    it('permits production URL override in dev mode when VITE_ALLOW_PROD_SYNC is true', () => {
      const url = getSyncApiUrl({
        VITE_SYNC_API_URL: 'https://app.lamanihub.com',
        VITE_ALLOW_PROD_SYNC: true,
        DEV: true,
      });
      expect(url).toBe('https://app.lamanihub.com');
    });
  });
});
