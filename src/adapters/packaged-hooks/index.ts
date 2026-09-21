/**
 * Packaged Hooks Registry (Phase 6)
 * Static registry of allowlisted TypeScript hooks.
 * AGENTS.md Rule 2: Absolute ban on eval, new Function, or dynamic remote imports.
 */

import { LamaniError } from '../../core/errors.js';
import { acmeExtractCsrf, acmeFormatDisplayTime, type PackagedHookContext } from './acme-hooks.js';
import {
  vendorCms1ExtractCsrf,
  vendorCms1FormatDisplayTime,
  vendorCms1TenantBTransform,
} from './vendor-cms-1-hooks.js';

export type PackagedHookFn = (context: PackagedHookContext) => unknown | Promise<unknown>;

export const PACKAGED_HOOKS: Record<string, PackagedHookFn> = {
  'acme-extract-csrf': acmeExtractCsrf,
  'acme-format-display-time': acmeFormatDisplayTime,
  'vendor-cms-1-extract-csrf': vendorCms1ExtractCsrf,
  'vendor-cms-1-format-display-time': vendorCms1FormatDisplayTime,
  'vendor-cms-1-tenant-b-transform': vendorCms1TenantBTransform,
};

export const ALLOWLISTED_PACKAGED_HOOK_NAMES = Object.keys(PACKAGED_HOOKS) as readonly string[];

export function isPackagedHookRegistered(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PACKAGED_HOOKS, name);
}

export async function executePackagedHook(
  name: string,
  context: PackagedHookContext = {}
): Promise<unknown> {
  if (!isPackagedHookRegistered(name)) {
    throw new LamaniError(
      `Packaged hook '${name}' is not registered in the pre-compiled allowlist`,
      'UNKNOWN_HOOK'
    );
  }

  const hookFn = PACKAGED_HOOKS[name];
  return await hookFn(context);
}

export * from './acme-hooks.js';
export * from './vendor-cms-1-hooks.js';

