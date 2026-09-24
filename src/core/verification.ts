/**
 * Read-After-Write Verifier (Phase 8)
 * Strictly enforces AGENTS.md Rule 10:
 * "An appointment is not confirmed until the CMS write is read back and verified."
 */

import { type WriteReceipt } from './contracts/commands.js';
import { areValuesEquivalent as baseEquivalent, extractField } from '../adapters/primitives/index.js';

export { areValuesEquivalent } from '../adapters/primitives/index.js';

export interface VerificationDiffResult {
  verified: boolean;
  writeReceipt?: WriteReceipt;
  mismatches?: Record<string, { expected: unknown; actual: unknown }>;
  reason?: string;
}

export interface VerifyReadBackOptions {
  expectedFields?: Record<string, string>;
  revisionPath?: string;
  idParam?: string;
  resolvedPatientId?: string;
  resolvedProviderId?: string;
}

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function extractNormalizedField(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const direct = extractField(obj, path);
  if (direct !== undefined && direct !== '') return direct;

  const snake = toSnakeCase(path);
  if (snake !== path) {
    const fromSnake = extractField(obj, snake);
    if (fromSnake !== undefined && fromSnake !== '') return fromSnake;
  }

  const camel = toCamelCase(path);
  if (camel !== path) {
    const fromCamel = extractField(obj, camel);
    if (fromCamel !== undefined && fromCamel !== '') return fromCamel;
  }

  // Doctor/provider alias for clinic CMSs (e.g. LamaniPulse doctor_id)
  if (path === 'providerId' || path === 'provider_id') {
    const doc = extractField(obj, 'doctorId') ?? extractField(obj, 'doctor_id');
    if (doc !== undefined && doc !== '') return doc;
  }

  // Composite date + time alias (e.g. appointment_date + appointment_time -> startTime)
  if (path === 'startTime' || path === 'start_time') {
    const date = extractField(obj, 'appointment_date') ?? extractField(obj, 'appointmentDate');
    const time = extractField(obj, 'appointment_time') ?? extractField(obj, 'appointmentTime');
    if (date && time) {
      return `${date}T${time}`;
    }
  }

  // Composite date + time + duration alias -> endTime
  if (path === 'endTime' || path === 'end_time') {
    const date = extractField(obj, 'appointment_date') ?? extractField(obj, 'appointmentDate');
    const time = extractField(obj, 'appointment_time') ?? extractField(obj, 'appointmentTime');
    const duration = Number(extractField(obj, 'duration_minutes') ?? extractField(obj, 'durationMinutes') ?? 30);
    if (date && time) {
      const timeStr = String(time);
      const [h, m] = timeStr.split(':').map(Number);
      if (!Number.isNaN(h) && !Number.isNaN(m)) {
        const totalMinutes = h * 60 + m + duration;
        const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
        const endM = String(totalMinutes % 60).padStart(2, '0');
        return `${date}T${endH}:${endM}:00`;
      }
    }
  }

  return direct;
}

function normalizeAction(action: string): string {
  return action.toUpperCase().replace(/^ACTION_/, '').replace(/-/g, '_');
}

/**
 * Compares requested command parameters against independently read-back CMS entity.
 * Generates field-level diffs and asserts correctness before confirmation.
 */
export function verifyReadBackRecord(
  action: string,
  intendedParams: Record<string, unknown>,
  readBackRecord: unknown,
  options: VerifyReadBackOptions = {}
): VerificationDiffResult {
  if (!readBackRecord || typeof readBackRecord !== 'object') {
    return {
      verified: false,
      reason: 'Read-back entity is null, undefined, or not an object',
    };
  }

  // Unwrap wrapper objects or arrays (e.g. { data: { ... } } or PostgREST [ { ... } ])
  const unwrapped = Array.isArray(readBackRecord) ? readBackRecord[0] : readBackRecord;
  if (!unwrapped || typeof unwrapped !== 'object') {
    return {
      verified: false,
      reason: 'Read-back entity is null, undefined, or not an object',
    };
  }

  const entity = (extractField(unwrapped, 'data') ?? unwrapped) as Record<string, unknown>;

  const mismatches: Record<string, { expected: unknown; actual: unknown }> = {};
  const normAction = normalizeAction(action);

  // 1. Action-specific canonical checks
  if (normAction === 'CREATE_APPOINTMENT' || normAction === 'APPOINTMENT_CREATE') {
    const actualPatientId = extractNormalizedField(entity, 'patientId');
    const expectedPatientId =
      options.resolvedPatientId ||
      (intendedParams.resolvedPatientId as string | undefined) ||
      (intendedParams.patientId as string | undefined) ||
      (intendedParams.patient_id as string | undefined);
    const patientMatches =
      baseEquivalent(actualPatientId, expectedPatientId) ||
      (options.resolvedPatientId && baseEquivalent(actualPatientId, options.resolvedPatientId)) ||
      (Boolean(actualPatientId) && !expectedPatientId);
    if (!patientMatches) {
      mismatches['patientId'] = { expected: expectedPatientId, actual: actualPatientId };
    }

    const actualProviderId = extractNormalizedField(entity, 'providerId');
    const expectedProviderId =
      options.resolvedProviderId ||
      (intendedParams.resolvedProviderId as string | undefined) ||
      (intendedParams.providerId as string | undefined) ||
      (intendedParams.provider_id as string | undefined);
    const providerMatches =
      baseEquivalent(actualProviderId, expectedProviderId) ||
      (options.resolvedProviderId && baseEquivalent(actualProviderId, options.resolvedProviderId)) ||
      (Boolean(actualProviderId) && !expectedProviderId);
    if (!providerMatches) {
      mismatches['providerId'] = { expected: expectedProviderId, actual: actualProviderId };
    }

    const actualStartTime = extractNormalizedField(entity, 'startTime');
    const expectedStartTime = intendedParams.startTime ?? intendedParams.start_time;
    if (!baseEquivalent(actualStartTime, expectedStartTime)) {
      mismatches['startTime'] = { expected: expectedStartTime, actual: actualStartTime };
    }

    const actualStatus = extractNormalizedField(entity, 'status');
    const validBookedStatuses = new Set(['booked', 'scheduled', 'confirmed']);
    const expectedStatus = (intendedParams.status as string) || 'booked';
    const isBothBooked = validBookedStatuses.has(String(actualStatus)) && validBookedStatuses.has(String(expectedStatus));
    if (!isBothBooked && actualStatus !== expectedStatus) {
      mismatches['status'] = { expected: expectedStatus, actual: actualStatus };
    }
  } else if (normAction === 'RESCHEDULE_APPOINTMENT' || normAction === 'APPOINTMENT_RESCHEDULE') {
    const actualStartTime = extractNormalizedField(entity, 'startTime');
    const expectedStartTime = intendedParams.startTime ?? intendedParams.start_time;
    if (!baseEquivalent(actualStartTime, expectedStartTime)) {
      mismatches['startTime'] = { expected: expectedStartTime, actual: actualStartTime };
    }

    if (intendedParams.endTime !== undefined || intendedParams.end_time !== undefined) {
      const actualEndTime = extractNormalizedField(entity, 'endTime');
      const expectedEndTime = intendedParams.endTime ?? intendedParams.end_time;
      if (!baseEquivalent(actualEndTime, expectedEndTime)) {
        mismatches['endTime'] = { expected: expectedEndTime, actual: actualEndTime };
      }
    }

    const actualStatus = extractNormalizedField(entity, 'status');
    if (actualStatus === 'cancelled') {
      mismatches['status'] = { expected: 'booked', actual: actualStatus };
    }
  } else if (normAction === 'CANCEL_APPOINTMENT' || normAction === 'APPOINTMENT_CANCEL') {
    const actualStatus = extractNormalizedField(entity, 'status');
    if (actualStatus !== 'cancelled') {
      mismatches['status'] = { expected: 'cancelled', actual: actualStatus };
    }
  } else if (normAction === 'CREATE_PATIENT' || normAction === 'PATIENT_CREATE') {
    const actualFullName = extractNormalizedField(entity, 'fullName');
    const expectedFullName = intendedParams.fullName ?? intendedParams.full_name;
    if (!baseEquivalent(actualFullName, expectedFullName)) {
      mismatches['fullName'] = { expected: expectedFullName, actual: actualFullName };
    }

    const actualPhone = extractNormalizedField(entity, 'phone');
    const expectedPhone = intendedParams.phone;
    if (!baseEquivalent(actualPhone, expectedPhone)) {
      mismatches['phone'] = { expected: expectedPhone, actual: actualPhone };
    }
  }

  // 2. Additional custom expected fields check
  if (options.expectedFields) {
    for (const [fieldPath, expectedParamOrLiteral] of Object.entries(options.expectedFields)) {
      const actualVal = extractNormalizedField(entity, fieldPath);
      const expectedVal = expectedParamOrLiteral.startsWith('$params.')
        ? extractNormalizedField(intendedParams, expectedParamOrLiteral.replace('$params.', ''))
        : expectedParamOrLiteral;

      if (!baseEquivalent(actualVal, expectedVal)) {
        mismatches[fieldPath] = { expected: expectedVal, actual: actualVal };
      }
    }
  }

  // If there are mismatches, verification fails closed
  if (Object.keys(mismatches).length > 0) {
    const mismatchSummary = Object.entries(mismatches)
      .map(([k, v]) => `${k}: expected '${String(v.expected)}', got '${String(v.actual)}'`)
      .join('; ');
    return {
      verified: false,
      mismatches,
      reason: `Read-after-write verification mismatch: ${mismatchSummary}`,
    };
  }

  // Extract entity ID
  const idField = options.idParam || 'id';
  const extractedId =
    (extractNormalizedField(entity, idField) as string | undefined) ||
    (extractNormalizedField(entity, 'id') as string | undefined) ||
    (intendedParams.appointmentId as string | undefined) ||
    (intendedParams.patientId as string | undefined) ||
    (intendedParams.id as string | undefined);

  if (!extractedId || typeof extractedId !== 'string') {
    return {
      verified: false,
      reason: 'Could not extract valid external entity ID from read-back record',
    };
  }

  // Extract revision number
  const revField = options.revisionPath || 'rev';
  const revRaw = extractNormalizedField(entity, revField);
  let revision = 1;
  if (typeof revRaw === 'number') {
    revision = revRaw;
  } else if (typeof revRaw === 'string' && /^\d+$/.test(revRaw)) {
    revision = parseInt(revRaw, 10);
  }

  const writeReceipt: WriteReceipt = {
    externalId: extractedId,
    revision,
    verifiedAt: new Date().toISOString(),
    metadata: {
      action: normAction,
      verifiedFields: Object.keys(intendedParams),
    },
  };

  return {
    verified: true,
    writeReceipt,
  };
}
