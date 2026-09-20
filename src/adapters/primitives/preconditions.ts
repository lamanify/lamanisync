/**
 * Precondition Evaluator (Phase 6)
 * Strictly bounded checks executed prior to write recipes (e.g. checking slot availability).
 * AGENTS.md Rule 2: Non-Turing complete allowlisted precondition rules.
 */

import { ConflictError, LamaniError } from '../../core/errors.js';
import { extractField } from './field-extractor.js';

export type PreconditionType = 'slot_availability' | 'field_equals';

export const ALLOWLISTED_PRECONDITION_TYPES: readonly PreconditionType[] = [
  'slot_availability',
  'field_equals',
] as const;

export function isAllowlistedPreconditionType(type: string): type is PreconditionType {
  return (ALLOWLISTED_PRECONDITION_TYPES as readonly string[]).includes(type);
}

export interface SlotAvailabilityPrecondition {
  type: 'slot_availability';
  endpoint: string; // e.g. "/api/appointments/availability"
  providerIdParam?: string; // defaults to "providerId"
  dateParam?: string; // defaults to "date"
  startTimeParam?: string; // defaults to "startTime"
}

export interface FieldEqualsPrecondition {
  type: 'field_equals';
  path: string; // dot-notation path in params
  expected?: unknown;
}

export type PreconditionConfig = SlotAvailabilityPrecondition | FieldEqualsPrecondition;

export interface PreconditionContext {
  params: Record<string, unknown>;
  headers?: Record<string, string>;
  baseOrigin?: string;
  fetchFn?: typeof fetch;
}

/**
 * Evaluates a single declarative precondition rule.
 */
export async function evaluatePrecondition(
  precondition: PreconditionConfig,
  context: PreconditionContext
): Promise<{ satisfied: boolean; reason?: string }> {
  if (!isAllowlistedPreconditionType(precondition.type)) {
    throw new LamaniError(
      `Precondition type '${((precondition as unknown) as Record<string, unknown>).type}' is not allowlisted`,
      'UNKNOWN_PRIMITIVE'
    );
  }

  if (precondition.type === 'field_equals') {
    const actual = extractField(context.params, precondition.path);
    const matches =
      actual === precondition.expected ||
      (typeof actual === 'object' &&
        actual !== null &&
        typeof precondition.expected === 'object' &&
        precondition.expected !== null &&
        JSON.stringify(actual) === JSON.stringify(precondition.expected));

    if (!matches) {
      const expStr = typeof precondition.expected === 'string' ? `'${precondition.expected}'` : JSON.stringify(precondition.expected);
      const actStr = typeof actual === 'string' ? `'${actual}'` : JSON.stringify(actual);
      return {
        satisfied: false,
        reason: `Field '${precondition.path}' expected ${expStr}, but got ${actStr}`,
      };
    }
    return { satisfied: true };
  }

  if (precondition.type === 'slot_availability') {
    const { params, baseOrigin, fetchFn, headers } = context;
    const providerIdKey = precondition.providerIdParam || 'providerId';
    const startTimeKey = precondition.startTimeParam || 'startTime';

    const providerId = params[providerIdKey];
    const startTime = params[startTimeKey];

    if (!providerId || !startTime || typeof startTime !== 'string') {
      return { satisfied: false, reason: 'Missing providerId or startTime for slot availability check' };
    }

    const dateStr = startTime.split('T')[0];
    if (!fetchFn || !baseOrigin) {
      // If no fetch context available, pass through
      return { satisfied: true };
    }

    const url = new URL(precondition.endpoint, baseOrigin);
    url.searchParams.set('providerId', String(providerId));
    url.searchParams.set('date', dateStr);

    try {
      const res = await fetchFn(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', ...(headers || {}) },
        credentials: 'include',
      });

      if (!res.ok) {
        return { satisfied: false, reason: `Availability check returned HTTP ${res.status}` };
      }

      const body = (await res.json()) as { slots?: Array<{ startTime: string; available: boolean }> };
      if (!Array.isArray(body.slots)) {
        return { satisfied: true }; // No slots array, pass through
      }

      const slot = body.slots.find((s) => s.startTime === startTime);
      if (slot && !slot.available) {
        return {
          satisfied: false,
          reason: `Slot at ${startTime} with provider ${providerId} is already booked`,
        };
      }

      return { satisfied: true };
    } catch (err) {
      throw new LamaniError(
        `Failed to verify slot availability precondition: ${(err as Error).message}`,
        'PRECONDITION_CHECK_FAILED'
      );
    }
  }

  return { satisfied: true };
}

/**
 * Asserts all preconditions pass; throws ConflictError if any fails.
 */
export async function assertPreconditions(
  preconditions: PreconditionConfig[],
  context: PreconditionContext
): Promise<void> {
  for (const prec of preconditions) {
    const result = await evaluatePrecondition(prec, context);
    if (!result.satisfied) {
      throw new ConflictError(result.reason || 'Precondition check failed', {
        details: { precondition: prec, reason: result.reason },
      });
    }
  }
}
