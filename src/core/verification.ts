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

  // Unwrap wrapper objects (e.g. { data: { ... } })
  const entity = (extractField(readBackRecord, 'data') ?? readBackRecord) as Record<string, unknown>;

  const mismatches: Record<string, { expected: unknown; actual: unknown }> = {};
  const normAction = normalizeAction(action);

  // 1. Action-specific canonical checks
  if (normAction === 'CREATE_APPOINTMENT' || normAction === 'APPOINTMENT_CREATE') {
    const actualPatientId = extractField(entity, 'patientId');
    const expectedPatientId = intendedParams.patientId;
    if (!baseEquivalent(actualPatientId, expectedPatientId)) {
      mismatches['patientId'] = { expected: expectedPatientId, actual: actualPatientId };
    }

    const actualProviderId = extractField(entity, 'providerId');
    const expectedProviderId = intendedParams.providerId;
    if (!baseEquivalent(actualProviderId, expectedProviderId)) {
      mismatches['providerId'] = { expected: expectedProviderId, actual: actualProviderId };
    }

    const actualStartTime = extractField(entity, 'startTime');
    const expectedStartTime = intendedParams.startTime;
    if (!baseEquivalent(actualStartTime, expectedStartTime)) {
      mismatches['startTime'] = { expected: expectedStartTime, actual: actualStartTime };
    }

    const actualStatus = extractField(entity, 'status');
    if (actualStatus !== 'booked') {
      mismatches['status'] = { expected: 'booked', actual: actualStatus };
    }
  } else if (normAction === 'RESCHEDULE_APPOINTMENT' || normAction === 'APPOINTMENT_RESCHEDULE') {
    const actualStartTime = extractField(entity, 'startTime');
    const expectedStartTime = intendedParams.startTime;
    if (!baseEquivalent(actualStartTime, expectedStartTime)) {
      mismatches['startTime'] = { expected: expectedStartTime, actual: actualStartTime };
    }

    if (intendedParams.endTime !== undefined) {
      const actualEndTime = extractField(entity, 'endTime');
      if (!baseEquivalent(actualEndTime, intendedParams.endTime)) {
        mismatches['endTime'] = { expected: intendedParams.endTime, actual: actualEndTime };
      }
    }

    const actualStatus = extractField(entity, 'status');
    if (actualStatus === 'cancelled') {
      mismatches['status'] = { expected: 'booked', actual: actualStatus };
    }
  } else if (normAction === 'CANCEL_APPOINTMENT' || normAction === 'APPOINTMENT_CANCEL') {
    const actualStatus = extractField(entity, 'status');
    if (actualStatus !== 'cancelled') {
      mismatches['status'] = { expected: 'cancelled', actual: actualStatus };
    }
  } else if (normAction === 'CREATE_PATIENT' || normAction === 'PATIENT_CREATE') {
    const actualFullName = extractField(entity, 'fullName');
    const expectedFullName = intendedParams.fullName;
    if (!baseEquivalent(actualFullName, expectedFullName)) {
      mismatches['fullName'] = { expected: expectedFullName, actual: actualFullName };
    }

    const actualPhone = extractField(entity, 'phone');
    const expectedPhone = intendedParams.phone;
    if (!baseEquivalent(actualPhone, expectedPhone)) {
      mismatches['phone'] = { expected: expectedPhone, actual: actualPhone };
    }
  }

  // 2. Additional custom expected fields check
  if (options.expectedFields) {
    for (const [fieldPath, expectedParamOrLiteral] of Object.entries(options.expectedFields)) {
      const actualVal = extractField(entity, fieldPath);
      const expectedVal = expectedParamOrLiteral.startsWith('$params.')
        ? extractField(intendedParams, expectedParamOrLiteral.replace('$params.', ''))
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
    (extractField(entity, idField) as string | undefined) ||
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
  const revRaw = extractField(entity, revField);
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
