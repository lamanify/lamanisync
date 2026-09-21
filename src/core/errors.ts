import { ZodError } from 'zod';
import type { RedactedDiagnostic } from './contracts/diagnostics.js';

export interface ErrorOptions {
  cause?: unknown;
  statusCode?: number;
  details?: Record<string, unknown>;
  isRetryable?: boolean;
}

export class LamaniError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly isRetryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, options: ErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = options.statusCode;
    this.isRetryable = options.isRetryable ?? false;
    this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthError extends LamaniError {
  constructor(message: string = 'Authentication or session failure', options: ErrorOptions = {}) {
    super(message, 'AUTH_ERROR', { statusCode: 401, isRetryable: false, ...options });
  }
}

export class ValidationError extends LamaniError {
  constructor(message: string = 'Validation failed', options: ErrorOptions = {}) {
    super(message, 'VALIDATION_ERROR', { statusCode: 400, isRetryable: false, ...options });
  }
}

export class ConflictError extends LamaniError {
  readonly currentRev?: number;
  readonly existingAppointmentId?: string;

  constructor(
    message: string = 'Conflict detected: slot collision or revision mismatch',
    options: ErrorOptions & { currentRev?: number; existingAppointmentId?: string } = {}
  ) {
    super(message, 'CONFLICT', { statusCode: 409, isRetryable: false, ...options });
    this.currentRev = options.currentRev;
    this.existingAppointmentId = options.existingAppointmentId;
  }
}

export class RateLimitError extends LamaniError {
  readonly retryAfterSeconds: number;

  constructor(
    message: string = 'Rate limit exceeded',
    options: ErrorOptions & { retryAfterSeconds?: number } = {}
  ) {
    super(message, 'RATE_LIMITED', { statusCode: 429, isRetryable: true, ...options });
    this.retryAfterSeconds = options.retryAfterSeconds ?? 30;
  }
}

export class TransientNetworkError extends LamaniError {
  constructor(message: string = 'Transient network or CMS error', options: ErrorOptions = {}) {
    super(message, 'TRANSIENT_NETWORK_ERROR', { statusCode: options.statusCode ?? 500, isRetryable: true, ...options });
  }
}

export class CmsSchemaError extends LamaniError {
  constructor(message: string = 'CMS response schema mismatch or drift', options: ErrorOptions = {}) {
    super(message, 'CMS_SCHEMA_ERROR', { statusCode: 502, isRetryable: false, ...options });
  }
}

export class IllegalTransitionError extends LamaniError {
  readonly fromState: string;
  readonly toState: string;

  constructor(fromState: string, toState: string, reason?: string) {
    const msg = `Illegal transition from '${fromState}' to '${toState}'${reason ? `: ${reason}` : ''}`;
    super(msg, 'ILLEGAL_TRANSITION', { isRetryable: false });
    this.fromState = fromState;
    this.toState = toState;
  }
}

export class FencingTokenError extends LamaniError {
  readonly expectedToken: number;
  readonly actualToken: number;

  constructor(expectedToken: number, actualToken: number) {
    super(
      `Stale fencing token: expected > ${expectedToken}, received ${actualToken}`,
      'FENCING_TOKEN_STALE',
      { isRetryable: false }
    );
    this.expectedToken = expectedToken;
    this.actualToken = actualToken;
  }
}

export {
  redactSensitiveString,
  redactSensitiveData,
  isSensitiveKey,
  SENSITIVE_KEY_SUBSTRINGS,
  ALLOWLISTED_KEYS,
  SENSITIVE_STRING_PATTERNS,
} from './redaction.js';
import { redactSensitiveString, redactSensitiveData } from './redaction.js';

export interface ClassifyErrorContext {
  statusCode?: number;
  endpoint?: string;
  method?: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
  isCmsResponse?: boolean;
  source?: 'cms' | 'sync_api' | 'extension';
}

/**
 * Classifies HTTP status codes, network errors, and schema errors into domain errors.
 */
export function classifyError(
  errorOrStatus: unknown,
  context?: ClassifyErrorContext
): LamaniError {
  if (errorOrStatus instanceof LamaniError) {
    return errorOrStatus;
  }

  if (errorOrStatus instanceof ZodError || (errorOrStatus instanceof Error && errorOrStatus.name === 'ZodError')) {
    const issues = (errorOrStatus as ZodError).issues?.map((i) => ({ path: i.path, message: i.message })) ?? [];
    if (context?.isCmsResponse || context?.source === 'cms') {
      return new CmsSchemaError('CMS response schema mismatch or drift', {
        cause: errorOrStatus,
        details: { issues },
      });
    }
    return new ValidationError('Schema validation failed', {
      cause: errorOrStatus,
      details: { issues },
    });
  }

  let status = context?.statusCode;
  let message = 'Unknown error occurred';

  if (typeof errorOrStatus === 'number') {
    status = errorOrStatus;
  } else if (errorOrStatus && typeof errorOrStatus === 'object') {
    const errObj = errorOrStatus as Record<string, unknown>;
    if (typeof errObj.message === 'string') {
      message = errObj.message;
    }
    const maybeStatus = errObj.status ?? errObj.statusCode;
    if (typeof maybeStatus === 'number') {
      status = maybeStatus;
    }
  } else if (typeof errorOrStatus === 'string') {
    message = errorOrStatus;
  }

  const safeDetails = context?.details ? (redactSensitiveData(context.details) as Record<string, unknown>) : undefined;

  switch (status) {
    case 401:
      return new AuthError(message || 'Unauthorized: session expired or missing', {
        statusCode: 401,
        details: safeDetails,
      });
    case 403:
      return new AuthError(message || 'Forbidden: insufficient permissions', {
        statusCode: 403,
        details: safeDetails,
      });
    case 409:
      return new ConflictError(message || 'Conflict: resource state changed concurrently', {
        statusCode: 409,
        details: safeDetails,
        currentRev: typeof safeDetails?.currentRev === 'number' ? safeDetails.currentRev : undefined,
        existingAppointmentId: typeof safeDetails?.existingAppointmentId === 'string' ? safeDetails.existingAppointmentId : undefined,
      });
    case 429: {
      const errObj = typeof errorOrStatus === 'object' && errorOrStatus !== null ? (errorOrStatus as Record<string, unknown>) : undefined;
      const retryAfter =
        context?.retryAfterSeconds ??
        (typeof errObj?.retryAfterSeconds === 'number'
          ? errObj.retryAfterSeconds
          : typeof errObj?.retryAfter === 'number'
            ? errObj.retryAfter
            : 30);
      return new RateLimitError(message || 'Rate limit exceeded by CMS or API', {
        statusCode: 429,
        retryAfterSeconds: retryAfter,
        details: safeDetails,
      });
    }
    case 500:
    case 502:
    case 503:
    case 504:
      return new TransientNetworkError(message || `Upstream server error (${status})`, {
        statusCode: status,
        details: safeDetails,
      });
    default:
      if (status && status >= 400 && status < 500) {
        return new ValidationError(message || `Client error (${status})`, {
          statusCode: status,
          details: safeDetails,
        });
      }
      return new TransientNetworkError(message, {
        statusCode: status ?? 500,
        details: safeDetails,
      });
  }
}

/**
 * Creates an anonymized diagnostic report from any caught error.
 */
export function toRedactedDiagnostic(
  error: unknown,
  correlationId?: string,
  installationId?: string
): RedactedDiagnostic {
  const classified = classifyError(error);
  const rawDetails = classified.details || (classified.cause instanceof Error ? { cause: classified.cause.message } : {});

  return {
    installationId: installationId || 'anonymous',
    correlationId: correlationId || null,
    errorType: classified.code,
    redactedDetails: {
      message: redactSensitiveString(classified.message),
      statusCode: classified.statusCode ?? null,
      isRetryable: classified.isRetryable,
      ...(redactSensitiveData(rawDetails) as Record<string, unknown>),
    },
    timestamp: new Date().toISOString(),
  };
}
