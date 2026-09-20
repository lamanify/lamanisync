/**
 * Read-After-Write Verification (Phase 6)
 * Strictly enforces AGENTS.md Rule 10:
 * "An appointment is not confirmed until the CMS write is read back and verified."
 */

import { LamaniError } from '../../core/errors.js';
import { extractField } from './field-extractor.js';
import { interpolatePath } from './matchers.js';

export interface VerificationRecipeConfig {
  path: string; // e.g. "/api/appointments/:id"
  method?: 'GET'; // Read query is always GET
  idParam?: string; // param key holding external ID, defaults to "id"
  expectedFields?: Record<string, string>; // path in verified entity -> path in params or literal value
  revisionPath?: string; // path to revision number, defaults to "rev"
}

export interface WriteReceipt {
  externalId: string;
  revision: number;
  verifiedAt: string;
  data?: unknown;
}

export interface VerificationContext {
  baseOrigin: string;
  params: Record<string, unknown>;
  writeResponseData: unknown;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

export function areValuesEquivalent(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return false;
  }

  // String / Number equivalence
  if (String(actual) === String(expected)) return true;

  // Date timestamp equivalence (e.g. UTC Z vs +08:00 offset)
  if (typeof actual === 'string' && typeof expected === 'string') {
    const d1 = new Date(actual).getTime();
    const d2 = new Date(expected).getTime();
    if (!isNaN(d1) && !isNaN(d2) && d1 === d2) {
      return true;
    }
  }

  // Object / Array deep equivalence
  if (typeof actual === 'object' && typeof expected === 'object') {
    try {
      return JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Executes read-after-write verification recipe against the CMS,
 * asserting that the written entity is read back and verified.
 */
export async function executeWriteVerification(
  recipe: VerificationRecipeConfig,
  context: VerificationContext
): Promise<WriteReceipt> {
  const { baseOrigin, params, writeResponseData, fetchFn, headers } = context;

  if (!fetchFn) {
    throw new LamaniError('fetch is required to execute read-after-write verification', 'FETCH_UNAVAILABLE');
  }

  // Determine external entity ID: from writeResponseData.id, or writeResponseData.data.id, or params
  const extractedId =
    extractField(writeResponseData, 'data.id') ||
    extractField(writeResponseData, 'id') ||
    params[recipe.idParam || 'id'];

  if (!extractedId || typeof extractedId !== 'string') {
    throw new LamaniError(
      'Cannot execute read-after-write verification: missing external entity ID in CMS response',
      'VERIFICATION_FAILED'
    );
  }

  const queryParams = {
    ...params,
    [recipe.idParam || 'id']: extractedId,
    id: extractedId,
  };

  const readPath = interpolatePath(recipe.path, queryParams);
  const targetUrl = `${baseOrigin.replace(/\/$/, '')}${readPath}`;

  let readRes: Response;
  try {
    readRes = await fetchFn(targetUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(headers || {}) },
      credentials: 'include',
    });
  } catch (err) {
    throw new LamaniError(
      `Read-after-write verification network request failed: ${(err as Error).message}`,
      'VERIFICATION_FAILED'
    );
  }

  if (!readRes.ok) {
    throw new LamaniError(
      `Read-after-write verification read back failed with status ${readRes.status}`,
      'VERIFICATION_FAILED',
      { statusCode: readRes.status }
    );
  }

  let readJson: unknown;
  try {
    readJson = await readRes.json();
  } catch {
    throw new LamaniError('Read-after-write verification returned invalid JSON', 'VERIFICATION_FAILED');
  }

  const entity = extractField(readJson, 'data') ?? readJson;
  const verifiedId = extractField(entity, recipe.idParam || 'id') ?? extractField(entity, 'id');

  if (verifiedId !== extractedId) {
    throw new LamaniError(
      `Read-after-write verification ID mismatch: expected '${extractedId}', got '${verifiedId}'`,
      'VERIFICATION_FAILED'
    );
  }

  // Field equivalence check
  if (recipe.expectedFields) {
    for (const [entityFieldPath, expectedParamOrLiteral] of Object.entries(recipe.expectedFields)) {
      const actualVal = extractField(entity, entityFieldPath);
      // If starts with '$params.', compare with params value, else literal
      const expectedVal = expectedParamOrLiteral.startsWith('$params.')
        ? extractField(params, expectedParamOrLiteral.replace('$params.', ''))
        : expectedParamOrLiteral;

      if (!areValuesEquivalent(actualVal, expectedVal)) {
        throw new LamaniError(
          `Read-after-write field mismatch for '${entityFieldPath}': expected '${expectedVal}', got '${actualVal}'`,
          'VERIFICATION_FAILED'
        );
      }
    }
  }

  const revVal = extractField(entity, recipe.revisionPath || 'rev');
  let revision = 1;
  if (typeof revVal === 'number') {
    revision = revVal;
  } else if (typeof revVal === 'string' && /^\d+$/.test(revVal)) {
    revision = parseInt(revVal, 10);
  }

  return {
    externalId: extractedId,
    revision,
    verifiedAt: new Date().toISOString(),
    data: entity,
  };
}
