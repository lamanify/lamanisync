/**
 * Allowlisted Named Transforms (Phase 6)
 * Strictly bounded, non-Turing complete field transformations.
 * AGENTS.md Rule 2: Absolute ban on eval, new Function, or arbitrary code.
 */

import { LamaniError } from '../../core/errors.js';

export function transformTrim(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.trim();
  }
  return value;
}

export function transformIsoDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      throw new LamaniError(`Invalid date format for iso_date transform: ${value}`, 'TRANSFORM_FAILED');
    }
    return d.toISOString();
  }
  throw new LamaniError(`Expected string, number, or Date for iso_date, received ${typeof value}`, 'TRANSFORM_FAILED');
}

export function transformPhoneMy(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LamaniError(`Expected string for phone_my transform, received ${typeof value}`, 'TRANSFORM_FAILED');
  }

  // Strip non-digit characters except leading plus
  const hasLeadingPlus = value.trim().startsWith('+');
  const digitsOnly = value.replace(/\D/g, '');

  if (hasLeadingPlus && !digitsOnly.startsWith('60')) {
    throw new LamaniError(
      `Foreign country code detected in '${value}', expected Malaysian (+60) number`,
      'TRANSFORM_FAILED'
    );
  }

  let normalized: string;
  if (digitsOnly.startsWith('60')) {
    normalized = `+${digitsOnly}`;
  } else if (digitsOnly.startsWith('0')) {
    normalized = `+60${digitsOnly.slice(1)}`;
  } else {
    throw new LamaniError(
      `Invalid Malaysian phone number '${value}': must start with 0, 60, or +60`,
      'TRANSFORM_FAILED'
    );
  }

  // Malaysian phones: +60 followed by 8 to 11 digits
  const malaysianPhonePattern = /^\+60[1-9]\d{7,10}$/;
  if (!malaysianPhonePattern.test(normalized)) {
    throw new LamaniError(
      `Normalized phone '${normalized}' does not match Malaysian mobile/landline format`,
      'TRANSFORM_FAILED'
    );
  }

  return normalized;
}

export function transformLowercase(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  return value;
}

export function transformUppercase(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.toUpperCase();
  }
  return value;
}

export function transformInteger(value: unknown): number {
  const parsed = parseInt(String(value), 10);
  if (isNaN(parsed)) {
    throw new LamaniError(`Cannot parse integer from ${value}`, 'TRANSFORM_FAILED');
  }
  return parsed;
}

export function transformString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export const ALLOWLISTED_TRANSFORMS = {
  trim: transformTrim,
  iso_date: transformIsoDate,
  phone_my: transformPhoneMy,
  lowercase: transformLowercase,
  uppercase: transformUppercase,
  integer: transformInteger,
  string: transformString,
} as const;

export type AllowlistedTransformName = keyof typeof ALLOWLISTED_TRANSFORMS;

export const ALLOWLISTED_TRANSFORM_NAMES = Object.keys(ALLOWLISTED_TRANSFORMS) as readonly AllowlistedTransformName[];

export function isAllowlistedTransform(name: string): name is AllowlistedTransformName {
  return Object.prototype.hasOwnProperty.call(ALLOWLISTED_TRANSFORMS, name);
}

export function applyTransform(name: string, value: unknown): unknown {
  if (!isAllowlistedTransform(name)) {
    throw new LamaniError(
      `Transform '${name}' is not an allowlisted primitive. Arbitrary transformations are forbidden.`,
      'UNKNOWN_PRIMITIVE'
    );
  }
  return ALLOWLISTED_TRANSFORMS[name](value);
}
