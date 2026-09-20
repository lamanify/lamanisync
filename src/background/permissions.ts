/**
 * Permissions Manager (Phase 4)
 * Handles user-gesture-initiated exact-origin host permissions requests.
 * Strictly enforces AGENTS.md Rule 3:
 * "Never request a runtime host permission broader than the exact paired CMS origin."
 * Rejects wildcards (*://* /*, https://* /*) and origin mismatches.
 */

import { TargetOriginSchema } from '../core/contracts/primitives.js';
import { LamaniError } from '../core/errors.js';

export interface ChromePermissionsApi {
  request(permissions: chrome.permissions.Permissions): Promise<boolean>;
  contains(permissions: chrome.permissions.Permissions): Promise<boolean>;
  remove(permissions: chrome.permissions.Permissions): Promise<boolean>;
}

function getPermissionsApi(custom?: ChromePermissionsApi): ChromePermissionsApi {
  if (custom) return custom;
  if (typeof chrome !== 'undefined' && chrome.permissions) {
    return chrome.permissions as unknown as ChromePermissionsApi;
  }
  throw new Error('chrome.permissions API is not available in current context');
}

/**
 * Normalizes and strictly validates an exact CMS origin.
 * Fails closed on wildcards, paths, queries, fragments, credentials, or non-http/https.
 */
export function normalizeExactOrigin(origin: string): string {
  if (!origin || typeof origin !== 'string') {
    throw new LamaniError('Origin must be a non-empty string', 'INVALID_ORIGIN');
  }

  // Strictly reject wildcards before URL parsing
  if (origin.includes('*')) {
    throw new LamaniError(
      'Wildcard host permissions are strictly prohibited. Exact paired CMS origin required.',
      'BROAD_PERMISSION_REJECTED'
    );
  }

  const result = TargetOriginSchema.safeParse(origin);
  if (!result.success) {
    throw new LamaniError(
      'Invalid exact origin format. Expected http://host:port or https://host',
      'INVALID_ORIGIN',
      { details: { issues: result.error.issues } }
    );
  }

  return result.data;
}

/**
 * Converts an exact origin (e.g. http://localhost:4001) to a Chrome host match pattern (http://localhost:4001/*).
 */
export function toExactOriginPattern(origin: string): string {
  const normalized = normalizeExactOrigin(origin);
  return `${normalized}/*`;
}

/**
 * Validates that a requested origin strictly matches the paired target origin.
 * Fails closed on any discrepancy or wildcard.
 */
export function validateOriginMatch(requestedOrigin: string, expectedOrigin: string): void {
  const normRequested = normalizeExactOrigin(requestedOrigin);
  const normExpected = normalizeExactOrigin(expectedOrigin);

  if (normRequested !== normExpected) {
    throw new LamaniError(
      `Permission request origin mismatch: requested ${normRequested} does not match paired CMS origin ${normExpected}`,
      'ORIGIN_MISMATCH',
      { statusCode: 403, details: { requestedOrigin: normRequested, expectedOrigin: normExpected } }
    );
  }
}

/**
 * Requests exact-origin host permission.
 * MUST be invoked in response to an explicit user gesture (e.g., button click).
 */
export async function requestOriginPermission(
  targetOrigin: string,
  expectedOrigin?: string,
  permissionsApi?: ChromePermissionsApi
): Promise<boolean> {
  const api = getPermissionsApi(permissionsApi);
  const normalized = normalizeExactOrigin(targetOrigin);

  if (expectedOrigin) {
    validateOriginMatch(normalized, expectedOrigin);
  }

  const pattern = toExactOriginPattern(normalized);

  try {
    const granted = await api.request({
      origins: [pattern],
    });
    return Boolean(granted);
  } catch (err) {
    throw new LamaniError(
      'Failed to request host permission from browser',
      'PERMISSION_REQUEST_FAILED',
      { cause: err }
    );
  }
}

/**
 * Checks whether the extension currently has permission for the exact origin.
 */
export async function hasOriginPermission(
  origin: string,
  permissionsApi?: ChromePermissionsApi
): Promise<boolean> {
  const api = getPermissionsApi(permissionsApi);
  const pattern = toExactOriginPattern(origin);

  try {
    return await api.contains({
      origins: [pattern],
    });
  } catch {
    return false;
  }
}

/**
 * Removes runtime host permission for the exact origin during unpair / revocation.
 */
export async function removeOriginPermission(
  origin: string,
  permissionsApi?: ChromePermissionsApi
): Promise<boolean> {
  const api = getPermissionsApi(permissionsApi);
  const pattern = toExactOriginPattern(origin);

  try {
    return await api.remove({
      origins: [pattern],
    });
  } catch {
    return false;
  }
}
