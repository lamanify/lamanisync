/**
 * Two-World Boundary & Message Validator (Phase 5)
 * Strictly validates window.postMessage events crossing the MAIN <-> ISOLATED boundary.
 * Conforms to AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, bearer tokens, or CSRF secrets.
 * Rule 8: Page-world code may execute only predefined adapter action IDs.
 * Rule 9: Validate every message at runtime.
 */

import { z } from 'zod';
import { normalizeExactOrigin } from '../background/permissions.js';
import { LamaniError, toRedactedDiagnostic } from '../core/errors.js';
import type { RedactedDiagnostic } from '../core/contracts/diagnostics.js';

export const BRIDGE_CHANNEL = 'LAMANISYNC_PAGE_BRIDGE' as const;
export const SOURCE_MAIN = 'LAMANISYNC_MAIN' as const;
export const SOURCE_ISOLATED = 'LAMANISYNC_ISOLATED' as const;

export type BridgeSource = typeof SOURCE_MAIN | typeof SOURCE_ISOLATED;

// --- Payload Schemas ---

export const HandshakeRequestPayloadSchema = z
  .object({
    nonce: z.string().min(1),
  })
  .strict();

export const HandshakeInitPayloadSchema = z
  .object({
    nonce: z.string().min(1),
  })
  .strict();

export const HandshakeAckPayloadSchema = z
  .object({
    acknowledged: z.literal(true),
  })
  .strict();

export const ENDPOINT_REGEX = /^\/[a-zA-Z0-9_\-/:?&=%.*,()+;$@~]*$/;

export const ObservationPayloadSchema = z
  .object({
    endpoint: z.string().min(1).regex(ENDPOINT_REGEX),
    method: z.enum(['GET', 'HEAD']),
    statusCode: z.number().int(),
    data: z.unknown(),
    timestamp: z.string().min(1),
  })
  .strict();

export const ExecuteActionPayloadSchema = z
  .object({
    actionId: z.string().min(1).regex(/^ACTION_[A-Z0-9_]+$/),
    correlationId: z.string().min(1),
    parameters: z.record(z.unknown()).default({}),
  })
  .strict();

export const ActionResultStatusSchema = z.enum(['SUCCESS', 'CONFLICT', 'RATE_LIMITED', 'ERROR']);

export const ActionResultPayloadSchema = z
  .object({
    actionId: z.string().min(1),
    correlationId: z.string().min(1),
    status: ActionResultStatusSchema,
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.record(z.unknown()).optional(),
      })
      .optional(),
  })
  .strict();

// --- Complete Bridge Message Schemas ---

export const MainHandshakeRequestSchema = z
  .object({
    channel: z.literal(BRIDGE_CHANNEL),
    source: z.literal(SOURCE_MAIN),
    type: z.literal('HANDSHAKE_REQUEST'),
    payload: HandshakeRequestPayloadSchema,
  })
  .strict();

export const IsolatedHandshakeInitSchema = z
  .object({
    channel: z.literal(BRIDGE_CHANNEL),
    source: z.literal(SOURCE_ISOLATED),
    token: z.string().min(1),
    type: z.literal('HANDSHAKE_INIT'),
    payload: HandshakeInitPayloadSchema,
  })
  .strict();

export const MainHandshakeAckSchema = z
  .object({
    channel: z.literal(BRIDGE_CHANNEL),
    source: z.literal(SOURCE_MAIN),
    token: z.string().min(1),
    type: z.literal('HANDSHAKE_ACK'),
    payload: HandshakeAckPayloadSchema,
  })
  .strict();

export const MainObservationMessageSchema = z
  .object({
    channel: z.literal(BRIDGE_CHANNEL),
    source: z.literal(SOURCE_MAIN),
    token: z.string().min(1),
    type: z.literal('OBSERVATION'),
    payload: ObservationPayloadSchema,
  })
  .strict();

export const IsolatedExecuteActionSchema = z
  .object({
    channel: z.literal(BRIDGE_CHANNEL),
    source: z.literal(SOURCE_ISOLATED),
    token: z.string().min(1),
    type: z.literal('EXECUTE_ACTION'),
    payload: ExecuteActionPayloadSchema,
  })
  .strict();

export const MainActionResultMessageSchema = z
  .object({
    channel: z.literal(BRIDGE_CHANNEL),
    source: z.literal(SOURCE_MAIN),
    token: z.string().min(1),
    type: z.literal('ACTION_RESULT'),
    payload: ActionResultPayloadSchema,
  })
  .strict();

export const PageToIsolatedMessageSchema = z.discriminatedUnion('type', [
  MainHandshakeRequestSchema,
  MainHandshakeAckSchema,
  MainObservationMessageSchema,
  MainActionResultMessageSchema,
]);

export const IsolatedToPageMessageSchema = z.discriminatedUnion('type', [
  IsolatedHandshakeInitSchema,
  IsolatedExecuteActionSchema,
]);

export type PageToIsolatedMessage = z.infer<typeof PageToIsolatedMessageSchema>;
export type IsolatedToPageMessage = z.infer<typeof IsolatedToPageMessageSchema>;
export type BridgeMessage = PageToIsolatedMessage | IsolatedToPageMessage;

export interface ValidatePageMessageOptions {
  event: {
    origin: string;
    source: unknown;
    data: unknown;
  };
  expectedOrigin: string;
  handshakeToken?: string | null;
  expectedSource?: BridgeSource;
  currentWindow?: unknown;
}

export type ValidationResult<T> =
  | { success: true; message: T; ignored?: false }
  | { success: false; ignored: true; error?: never; diagnostic?: never }
  | { success: false; ignored?: false; error: LamaniError; diagnostic: RedactedDiagnostic };

/**
 * Validates incoming window.postMessage events strictly.
 * Rejects untrusted iframes, mismatched origins, forged tokens, or schema drift.
 */
export function validateIncomingPageMessage<T = BridgeMessage>(
  options: ValidatePageMessageOptions
): ValidationResult<T> {
  const { event, expectedOrigin, handshakeToken, currentWindow } = options;
  const expectedSource = options.expectedSource || SOURCE_MAIN;

  // 1. Non-bridge message check (ignore benign page messages without failing)
  if (!event || typeof event !== 'object' || !event.data || typeof event.data !== 'object') {
    return { success: false, ignored: true };
  }

  const rawData = event.data as Record<string, unknown>;
  if (rawData.channel !== BRIDGE_CHANNEL) {
    return { success: false, ignored: true };
  }

  // 2. Strict origin check
  let normEventOrigin: string;
  let normExpectedOrigin: string;
  try {
    normEventOrigin = normalizeExactOrigin(event.origin);
    normExpectedOrigin = normalizeExactOrigin(expectedOrigin);
  } catch (err) {
    const error = new LamaniError(
      'Malformed event or expected origin',
      'ORIGIN_VALIDATION_FAILED',
      { statusCode: 403, cause: err }
    );
    return { success: false, error, diagnostic: toRedactedDiagnostic(error) };
  }

  if (normEventOrigin !== normExpectedOrigin) {
    const error = new LamaniError(
      `Message origin mismatch: expected ${normExpectedOrigin}, received ${normEventOrigin}`,
      'ORIGIN_MISMATCH',
      { statusCode: 403, details: { expectedOrigin: normExpectedOrigin, eventOrigin: normEventOrigin } }
    );
    return { success: false, error, diagnostic: toRedactedDiagnostic(error) };
  }

  // 3. Strict source window check (reject iframes, openers, child windows)
  const safeWindow = currentWindow !== undefined ? currentWindow : (typeof window !== 'undefined' ? window : null);
  if (safeWindow && event.source !== safeWindow) {
    const error = new LamaniError(
      'Message source is not the current top-level window. Untrusted frames strictly rejected.',
      'UNTRUSTED_SOURCE',
      { statusCode: 403 }
    );
    return { success: false, error, diagnostic: toRedactedDiagnostic(error) };
  }

  // 4. Source role check (ignore messages not intended for this world, e.g. self-sent echos)
  if (rawData.source !== expectedSource) {
    return { success: false, ignored: true };
  }

  // 5. Handshake token verification
  const msgType = String(rawData.type);
  if (msgType !== 'HANDSHAKE_REQUEST' && msgType !== 'HANDSHAKE_INIT') {
    if (!handshakeToken || rawData.token !== handshakeToken) {
      const error = new LamaniError(
        'Invalid or missing handshake token. Cross-world message forged or unauthenticated.',
        'INVALID_HANDSHAKE_TOKEN',
        { statusCode: 401 }
      );
      return { success: false, error, diagnostic: toRedactedDiagnostic(error) };
    }
  }

  // 6. Strict Zod schema parsing
  const schema = expectedSource === SOURCE_MAIN ? PageToIsolatedMessageSchema : IsolatedToPageMessageSchema;
  const parseResult = schema.safeParse(event.data);

  if (!parseResult.success) {
    const error = new LamaniError(
      'Cross-world message schema drift or malformed structure',
      'SCHEMA_VALIDATION_FAILED',
      { statusCode: 400, details: { issues: parseResult.error.issues } }
    );
    return { success: false, error, diagnostic: toRedactedDiagnostic(error) };
  }

  return { success: true, message: parseResult.data as unknown as T };
}
