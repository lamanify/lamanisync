/**
 * URL and HTTP Method Matchers (Phase 6)
 * Strict path equality or bounded parameter substitution.
 * AGENTS.md Rule 2: Strict bounds, no arbitrary regex, no eval.
 */

import { LamaniError } from '../../core/errors.js';

export const ALLOWLISTED_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
export type AllowlistedHttpMethod = typeof ALLOWLISTED_HTTP_METHODS[number];

export function isAllowlistedHttpMethod(method: string): method is AllowlistedHttpMethod {
  return (ALLOWLISTED_HTTP_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * Validates that parameter values do not contain path traversal, injection, or forbidden characters.
 */
export function validateParameterValue(name: string, value: unknown): string {
  if (value === null || value === undefined) {
    throw new LamaniError(`Missing required parameter '${name}'`, 'MISSING_PATH_PARAMETER');
  }

  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') {
    throw new LamaniError(`Parameter '${name}' must be a primitive value`, 'INVALID_PATH_PARAMETER');
  }

  const str = String(value).trim();
  if (!str) {
    throw new LamaniError(`Parameter '${name}' cannot be empty`, 'INVALID_PATH_PARAMETER');
  }

  // Reject path traversals, backslashes, schemes, and control characters
  const hasControlChars = [...str].some((c) => {
    const code = c.charCodeAt(0);
    return (code >= 0 && code <= 31) || code === 127;
  });

  if (str.includes('/') || str.includes('\\') || str.includes('..') || hasControlChars) {
    throw new LamaniError(
      `Parameter '${name}' contains unsafe characters (slashes, traversals, or control codes)`,
      'UNSAFE_PATH_PARAMETER'
    );
  }

  return str;
}

/**
 * Substitutes `:paramName` tokens in a template path with safe URI-encoded values.
 * Example: interpolatePath("/api/patients/:id", { id: "ZZTEST-P01" }) => "/api/patients/ZZTEST-P01"
 */
export function interpolatePath(template: string, params: Record<string, unknown>): string {
  if (!template.startsWith('/')) {
    throw new LamaniError(`Path template must start with '/', got '${template}'`, 'INVALID_PATH_TEMPLATE');
  }

  return template.replace(/:([a-zA-Z0-9_]+)/g, (_, paramName) => {
    const rawVal = params[paramName];
    const validated = validateParameterValue(paramName, rawVal);
    return encodeURIComponent(validated);
  });
}

/**
 * Matches an actual relative path against a template pattern and extracts parameters.
 * Linear-time split match (no ReDoS vulnerability).
 */
export function matchPath(
  template: string,
  actualPath: string
): { matches: boolean; params?: Record<string, string> } {
  // Strip query strings if present
  const cleanTemplate = template.split('?')[0];
  const cleanActual = actualPath.split('?')[0];

  const templateSegments = cleanTemplate.split('/').filter(Boolean);
  const actualSegments = cleanActual.split('/').filter(Boolean);

  if (templateSegments.length !== actualSegments.length) {
    return { matches: false };
  }

  const extractedParams: Record<string, string> = {};

  for (let i = 0; i < templateSegments.length; i++) {
    const tSeg = templateSegments[i];
    const aSeg = actualSegments[i];

    if (tSeg.startsWith(':')) {
      const paramName = tSeg.slice(1);
      try {
        extractedParams[paramName] = decodeURIComponent(aSeg);
      } catch {
        return { matches: false };
      }
    } else if (tSeg !== aSeg) {
      return { matches: false };
    }
  }

  return { matches: true, params: extractedParams };
}
