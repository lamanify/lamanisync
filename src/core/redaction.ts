/**
 * Redaction & Diagnostic Sanitization Utility (Phase 9)
 * Conforms strictly to AGENTS.md Rules:
 * Rule 4: Never copy or transmit CMS passwords, cookies, bearer tokens, or CSRF secrets.
 * Rule 5: Never use production patient data in tests or logs.
 * Rule 6: Do not store raw PHI in chrome.storage.local.
 */

// Words that always trigger redaction when present in object key name
export const SENSITIVE_KEY_SUBSTRINGS = [
  'password',
  'passwd',
  'token',
  'cookie',
  'session',
  'secret',
  'authorization',
  'bearer',
  'csrf',
  'xsrf',
  'jwt',
  'credential',
  'privatekey',
  'apikey',
  'pairingcode',
  'fullname',
  'firstname',
  'lastname',
  'patientname',
  'icorpassport',
  'nric',
  'passport',
  'mykad',
  'nationalid',
  'phone',
  'telephone',
  'mobile',
  'email',
  'dateofbirth',
  'birthdate',
  'dob',
  'notes',
  'medical',
  'clinical',
  'diagnosis',
  'prescription',
  'treatment',
  'complaint',
  'address',
  'street',
  'postcode',
  'postalcode',
  'zipcode',
];

// Specific non-sensitive metadata keys that should remain unredacted
export const ALLOWLISTED_KEYS = new Set([
  'id',
  'patientid',
  'providerid',
  'serviceid',
  'locationid',
  'connectionid',
  'installationid',
  'commandid',
  'batchid',
  'eventid',
  'adapterid',
  'actionid',
  'statuscode',
  'errortype',
  'revision',
  'timestamp',
  'occurredat',
  'verifiedat',
  'status',
  'endpoint',
  'method',
  'isretryable',
  'devicename',
  'adaptername',
  'servicename',
  'version',
  'adapterversion',
  'extensionversion',
  'state',
  'currentstate',
  'correlationid',
  'targetorigin',
  'lastreadat',
  'lastwriteat',
  'syncprogress',
  'pausereason',
  'errorsummary',
]);

export function isSensitiveKey(key: string): boolean {
  const clean = key.toLowerCase().replace(/[-_\s]/g, '');
  if (ALLOWLISTED_KEYS.has(clean)) return false;
  if (clean === 'name' || clean.endsWith('name')) {
    return true;
  }
  return SENSITIVE_KEY_SUBSTRINGS.some((substr) => clean.includes(substr));
}

// Regex patterns to scrub sensitive data embedded in strings/error messages
export const SENSITIVE_STRING_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  [/\b\d{6}-\d{2}-\d{4}\b/g, '[REDACTED_NRIC]'],
  [/\b\d{12}\b/g, '[REDACTED_NRIC]'],
  [/\b(?:\+?60|0)[1-9]\d{1,2}[-\s]?\d{6,8}\b/g, '[REDACTED_PHONE]'],
  [/(?:cms_session|session_token|token|secret|api_key|apikey)=[^;,\s&]+/gi, '$1=[REDACTED]'],
  [/\b(?:patient|client)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/gi, 'patient [REDACTED_NAME]'],
];

/**
 * Strips all query parameters and hash fragments from a URL string,
 * avoiding extraneous trailing slashes on origin root.
 */
export function scrubUrlQueryParams(urlStr: string): string {
  if (!urlStr) return '';
  try {
    const parsed = new URL(urlStr);
    parsed.search = '';
    parsed.hash = '';
    if (parsed.pathname === '/' && !urlStr.endsWith('/')) {
      return parsed.origin;
    }
    return parsed.toString();
  } catch {
    return urlStr.replace(/\?[^#\s]*/g, '').replace(/#[^\s]*/g, '');
  }
}

/**
 * Sanitizes a string by replacing recognized patterns of PHI and auth credentials.
 */
export function redactSensitiveString(str: string): string {
  let result = str;
  for (const [pattern, replacement] of SENSITIVE_STRING_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Recursively redacts sensitive auth secrets and patient health information (PHI).
 */
export function redactSensitiveData(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return redactSensitiveString(obj);
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      redacted[key] = redactSensitiveData(val);
    } else if (typeof val === 'string') {
      if (val.startsWith('http://') || val.startsWith('https://')) {
        redacted[key] = scrubUrlQueryParams(redactSensitiveString(val));
      } else {
        redacted[key] = redactSensitiveString(val);
      }
    } else {
      redacted[key] = val;
    }
  }
  return redacted;
}

export interface DiagnosticBundleInput {
  installationId?: string;
  connectionId?: string;
  adapterVersion?: string;
  extensionVersion?: string;
  currentState: string;
  correlationId?: string | null;
  targetOrigin?: string;
  lastReadAt?: string | null;
  lastWriteAt?: string | null;
  error?: unknown;
  rawDetails?: Record<string, unknown>;
  timestamp?: string;
}

export interface FormattedDiagnosticBundle {
  installationId: string;
  adapterVersion: string;
  extensionVersion: string;
  currentState: string;
  correlationId: string;
  targetOrigin: string;
  timestamp: string;
  lastReadAt?: string;
  lastWriteAt?: string;
  errorSummary?: string;
  redactedDetails?: Record<string, unknown>;
}

/**
 * Generates an exportable diagnostic bundle guaranteed zero PHI, zero session secrets,
 * and stripped of all URL query parameters.
 */
export function formatDiagnosticBundle(input: DiagnosticBundleInput): FormattedDiagnosticBundle {
  const safeOrigin = input.targetOrigin ? scrubUrlQueryParams(input.targetOrigin) : 'unconfigured';

  let errorSummary: string | undefined;
  let rawDetails: Record<string, unknown> | undefined = input.rawDetails;

  if (input.error) {
    if (typeof input.error === 'string') {
      errorSummary = redactSensitiveString(input.error);
    } else if (input.error instanceof Error) {
      errorSummary = redactSensitiveString(input.error.message);
      if (!rawDetails && 'details' in input.error) {
        rawDetails = (input.error as { details?: Record<string, unknown> }).details;
      }
    } else if (typeof input.error === 'object' && input.error !== null) {
      const errObj = input.error as Record<string, unknown>;
      if (typeof errObj.message === 'string') {
        errorSummary = redactSensitiveString(errObj.message);
      }
    }
  }

  const safeDetails = rawDetails
    ? (redactSensitiveData(rawDetails) as Record<string, unknown>)
    : undefined;

  const bundle: FormattedDiagnosticBundle = {
    installationId: input.installationId || 'unpaired',
    adapterVersion: input.adapterVersion || 'unknown',
    extensionVersion: input.extensionVersion || 'unknown',
    currentState: input.currentState,
    correlationId: input.correlationId || 'none',
    targetOrigin: safeOrigin,
    timestamp: input.timestamp || new Date().toISOString(),
  };

  if (input.lastReadAt) {
    bundle.lastReadAt = input.lastReadAt;
  }
  if (input.lastWriteAt) {
    bundle.lastWriteAt = input.lastWriteAt;
  }
  if (errorSummary) {
    bundle.errorSummary = errorSummary;
  }
  if (safeDetails && Object.keys(safeDetails).length > 0) {
    bundle.redactedDetails = safeDetails;
  }

  return bundle;
}
