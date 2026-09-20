/**
 * Safe Dot-Notation Field Extractor (Phase 6)
 * Traverses nested object structures with strictly bounded, non-Turing complete dot notation.
 * AGENTS.md Rule 2: No eval, no Function, no prototype pollution.
 */

import { LamaniError } from '../../core/errors.js';

const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PATH_SEGMENTS = 10;

/**
 * Safely extracts a value from an object using dot notation and array wildcards.
 * Examples:
 * - "data.id"
 * - "data.appointments[].id"
 * - "response.items.0.status"
 */
export function extractField(source: unknown, path: string): unknown {
  if (source === null || source === undefined) {
    return undefined;
  }

  if (typeof path !== 'string' || !path.trim()) {
    return source;
  }

  // Check for array wildcard notation e.g. "appointments[].id"
  if (path.includes('[]')) {
    const parts = path.split('[]');
    if (parts.length > 2) {
      throw new LamaniError('Nested array wildcards ([][]) exceed complexity bounds', 'COMPLEXITY_LIMIT_EXCEEDED');
    }

    const [arrayPath, itemPath] = parts;
    const arrayVal = arrayPath ? extractField(source, arrayPath) : source;

    if (!Array.isArray(arrayVal)) {
      return undefined;
    }

    const cleanItemPath = itemPath.startsWith('.') ? itemPath.slice(1) : itemPath;
    if (!cleanItemPath) {
      return arrayVal;
    }

    return arrayVal.map((item) => extractField(item, cleanItemPath));
  }

  const segments = path.split('.');
  if (segments.length > MAX_PATH_SEGMENTS) {
    throw new LamaniError(
      `Field path exceeds maximum complexity limit of ${MAX_PATH_SEGMENTS} segments: ${path}`,
      'COMPLEXITY_LIMIT_EXCEEDED'
    );
  }

  let current: unknown = source;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (FORBIDDEN_PROPERTIES.has(segment)) {
      throw new LamaniError(
        `Field path accesses forbidden property '${segment}'`,
        'UNSAFE_FIELD_PATH'
      );
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return undefined;
      }
      const idx = parseInt(segment, 10);
      if (idx >= current.length) {
        return undefined;
      }
      current = current[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}
