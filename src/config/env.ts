/**
 * Environment & Host Configuration (Phase 10)
 * Validates and exposes Sync API connection endpoints.
 * Strictly enforces AGENTS.md Rule 14: Never allow development builds to connect
 * to production LamaniHub URLs (e.g. app.lamani.my, api.lamanihub.com).
 */

import { LamaniError } from '../core/errors.js';

export const DEFAULT_DEV_SYNC_API_URL = 'http://localhost:4002';

const KNOWN_PRODUCTION_HOSTS = new Set([
  'app.lamani.my',
  'api.lamani.my',
  'sync.lamani.my',
  'lamani.my',
  'lamanihub.com',
  'app.lamanihub.com',
  'api.lamanihub.com',
  'sync.lamanihub.com',
  'prod-api.lamanihub.com',
  'production.lamanihub.com',
]);

/**
 * Determines whether a URL or hostname belongs to production LamaniHub infrastructure.
 */
export function isProductionDomain(urlOrHost: string): boolean {
  let hostname = urlOrHost.trim();
  try {
    const parsed = hostname.includes('://') ? new URL(hostname) : new URL(`http://${hostname}`);
    hostname = parsed.hostname;
  } catch {
    // If URL parsing fails, inspect raw string
  }

  hostname = hostname.toLowerCase();

  if (KNOWN_PRODUCTION_HOSTS.has(hostname)) {
    return true;
  }

  // Check subdomains of lamani.my and lamanihub.com
  const isLamaniDomain = hostname.endsWith('.lamani.my') || hostname.endsWith('.lamanihub.com');
  if (isLamaniDomain) {
    // Staging and test subdomains are not production
    const isStagingOrDev =
      hostname.includes('staging') ||
      hostname.includes('dev') ||
      hostname.includes('test') ||
      hostname.includes('demo') ||
      hostname.includes('mock');
    return !isStagingOrDev;
  }

  return false;
}

export interface EnvOverrides {
  VITE_SYNC_API_URL?: string;
  MODE?: string;
  DEV?: boolean;
}

/**
 * Detects whether the current execution runtime is in development mode.
 */
export function isDevelopment(overrides?: EnvOverrides): boolean {
  if (overrides?.DEV !== undefined) {
    return overrides.DEV;
  }
  if (overrides?.MODE !== undefined) {
    return overrides.MODE !== 'production';
  }

  try {
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      if (typeof import.meta.env.DEV === 'boolean') {
        return import.meta.env.DEV;
      }
      if (typeof import.meta.env.MODE === 'string') {
        return import.meta.env.MODE !== 'production';
      }
    }
  } catch {
    // Fallthrough to process.env
  }

  if (typeof process !== 'undefined' && process.env) {
    return process.env.NODE_ENV !== 'production';
  }

  return true;
}

/**
 * Validates a target Sync API URL against development environment safety rules.
 * Throws a LamaniError if a development build attempts to point to production LamaniHub.
 */
export function validateSyncApiUrl(url: string, isDev: boolean = true): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new LamaniError('Sync API URL cannot be empty', 'CONFIG_ERROR', { statusCode: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new LamaniError(`Invalid Sync API URL format: '${trimmed}'`, 'CONFIG_ERROR', {
      statusCode: 400,
      cause: err,
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LamaniError(`Sync API URL must use HTTP or HTTPS protocol: '${trimmed}'`, 'CONFIG_ERROR', {
      statusCode: 400,
    });
  }

  if (isDev && isProductionDomain(parsed.hostname)) {
    throw new LamaniError(
      `Development build prohibited from pointing to production LamaniHub endpoint: '${parsed.origin}' (AGENTS.md Rule 14)`,
      'PROD_ENDPOINT_PROHIBITED',
      { statusCode: 403, details: { origin: parsed.origin, hostname: parsed.hostname } }
    );
  }

  return parsed.origin;
}

/**
 * Resolves the active Sync API URL based on build-time environment variables,
 * with fallback to local mock server and strict safety checks.
 */
export function getSyncApiUrl(overrides?: EnvOverrides): string {
  let rawUrl: string | undefined;

  if (overrides?.VITE_SYNC_API_URL) {
    rawUrl = overrides.VITE_SYNC_API_URL;
  } else {
    try {
      if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SYNC_API_URL) {
        rawUrl = import.meta.env.VITE_SYNC_API_URL;
      }
    } catch {
      // Fallthrough to process.env
    }

    if (!rawUrl && typeof process !== 'undefined' && process.env?.VITE_SYNC_API_URL) {
      rawUrl = process.env.VITE_SYNC_API_URL;
    }
  }

  const targetUrl = rawUrl || DEFAULT_DEV_SYNC_API_URL;
  const isDev = isDevelopment(overrides);

  return validateSyncApiUrl(targetUrl, isDev);
}
