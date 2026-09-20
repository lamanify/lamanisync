// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AuthError,
  ValidationError,
  ConflictError,
  RateLimitError,
  TransientNetworkError,
  CmsSchemaError,
  IllegalTransitionError,
  FencingTokenError,
  classifyError,
  redactSensitiveData,
  toRedactedDiagnostic,
} from '../../src/core/errors.js';
import { RedactedDiagnosticSchema } from '../../src/core/contracts/diagnostics.js';

describe('Error Taxonomy, Classification & Redaction', () => {
  describe('Typed Error Hierarchy', () => {
    it('initializes typed error classes with expected defaults', () => {
      const auth = new AuthError();
      expect(auth.statusCode).toBe(401);
      expect(auth.isRetryable).toBe(false);

      const val = new ValidationError('Bad request');
      expect(val.statusCode).toBe(400);
      expect(val.isRetryable).toBe(false);

      const conflict = new ConflictError('Revision clash', { currentRev: 3, existingAppointmentId: 'APT-1' });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.isRetryable).toBe(false);
      expect(conflict.currentRev).toBe(3);
      expect(conflict.existingAppointmentId).toBe('APT-1');

      const rate = new RateLimitError('Too many requests', { retryAfterSeconds: 45 });
      expect(rate.statusCode).toBe(429);
      expect(rate.isRetryable).toBe(true);
      expect(rate.retryAfterSeconds).toBe(45);

      const net = new TransientNetworkError('Timeout', { statusCode: 504 });
      expect(net.statusCode).toBe(504);
      expect(net.isRetryable).toBe(true);

      const schema = new CmsSchemaError();
      expect(schema.statusCode).toBe(502);
      expect(schema.isRetryable).toBe(false);

      const transition = new IllegalTransitionError('UNPAIRED', 'ACTIVE');
      expect(transition.fromState).toBe('UNPAIRED');
      expect(transition.toState).toBe('ACTIVE');

      const fence = new FencingTokenError(3, 1);
      expect(fence.expectedToken).toBe(3);
      expect(fence.actualToken).toBe(1);
    });
  });

  describe('classifyError', () => {
    it('maps HTTP status codes into specific domain error classes', () => {
      expect(classifyError(401)).toBeInstanceOf(AuthError);
      expect(classifyError(403)).toBeInstanceOf(AuthError);
      expect(classifyError(409)).toBeInstanceOf(ConflictError);
      expect(classifyError(429)).toBeInstanceOf(RateLimitError);
      expect(classifyError(500)).toBeInstanceOf(TransientNetworkError);
      expect(classifyError(502)).toBeInstanceOf(TransientNetworkError);
      expect(classifyError(503)).toBeInstanceOf(TransientNetworkError);
      expect(classifyError(504)).toBeInstanceOf(TransientNetworkError);
    });

    it('classifies ZodError into ValidationError', () => {
      const schema = z.object({ count: z.number() });
      const result = schema.safeParse({ count: 'invalid' });
      if (!result.success) {
        const classified = classifyError(result.error);
        expect(classified).toBeInstanceOf(ValidationError);
        expect(classified.code).toBe('VALIDATION_ERROR');
      }
    });

    it('returns existing LamaniError unmodified', () => {
      const err = new RateLimitError('Wait');
      expect(classifyError(err)).toBe(err);
    });

    it('classifies plain fetch error objects with status code', () => {
      const plainObj = { status: 401, message: 'Session token expired' };
      const classified = classifyError(plainObj);
      expect(classified).toBeInstanceOf(AuthError);
      expect(classified.statusCode).toBe(401);
    });

    it('classifies CMS schema validation failures as CmsSchemaError when isCmsResponse is true', () => {
      const schema = z.object({ patientId: z.string() });
      const result = schema.safeParse({});
      if (!result.success) {
        const classified = classifyError(result.error, { isCmsResponse: true });
        expect(classified).toBeInstanceOf(CmsSchemaError);
        expect(classified.code).toBe('CMS_SCHEMA_ERROR');
        expect(classified.statusCode).toBe(502);
      }
    });

    it('extracts retry-after header or field on rate limit errors', () => {
      const rateLimitObj = { status: 429, message: 'Too many calls', retryAfter: 45 };
      const classified = classifyError(rateLimitObj) as RateLimitError;
      expect(classified).toBeInstanceOf(RateLimitError);
      expect(classified.retryAfterSeconds).toBe(45);
    });
  });

  describe('redactSensitiveData & toRedactedDiagnostic', () => {
    it('recursively redacts auth secrets and patient health information (PHI)', () => {
      const rawPayload = {
        statusCode: 409,
        endpoint: '/api/appointments/APT-001',
        token: 'secret_token_value',
        cookie: 'cms_session=abc123secret',
        authorization: 'Bearer sensitive-credential',
        pairingCode: 'PAIR-123-456',
        privateKey: '-----BEGIN PRIVATE KEY-----',
        apiKey: 'cms_api_live_secret',
        patient: {
          fullName: 'Siti Aminah',
          phoneNumber: '+60123456789',
          nric: '900101-14-5001',
          email: 'siti@example.com',
          medicalNotes: 'Confidential clinical history',
          dateOfBirth: '1990-01-01',
          unrelatedId: 'ZZTEST-P01',
        },
      };

      const redacted = redactSensitiveData(rawPayload) as typeof rawPayload;

      // Preserved non-sensitive fields
      expect(redacted.statusCode).toBe(409);
      expect(redacted.endpoint).toBe('/api/appointments/APT-001');
      expect(redacted.patient.unrelatedId).toBe('ZZTEST-P01');

      // Redacted auth secrets
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.cookie).toBe('[REDACTED]');
      expect(redacted.authorization).toBe('[REDACTED]');
      expect(redacted.pairingCode).toBe('[REDACTED]');
      expect(redacted.privateKey).toBe('[REDACTED]');
      expect(redacted.apiKey).toBe('[REDACTED]');

      // Redacted PHI
      expect(redacted.patient.fullName).toBe('[REDACTED]');
      expect(redacted.patient.phoneNumber).toBe('[REDACTED]');
      expect(redacted.patient.nric).toBe('[REDACTED]');
      expect(redacted.patient.email).toBe('[REDACTED]');
      expect(redacted.patient.medicalNotes).toBe('[REDACTED]');
      expect(redacted.patient.dateOfBirth).toBe('[REDACTED]');
    });

    it('scrubs sensitive PHI and auth tokens embedded in string error messages', () => {
      const rawMessage =
        'Error registering patient Siti Aminah (NRIC: 900101-14-5001, phone: +60123456789, email: siti@example.com) with token Bearer secret_token_xyz';

      const sanitized = redactSensitiveData(rawMessage) as string;

      expect(sanitized).not.toContain('900101-14-5001');
      expect(sanitized).not.toContain('siti@example.com');
      expect(sanitized).not.toContain('secret_token_xyz');
      expect(sanitized).toContain('[REDACTED_NRIC]');
      expect(sanitized).toContain('[REDACTED_EMAIL]');
      expect(sanitized).toContain('Bearer [REDACTED]');
    });

    it('creates compliant RedactedDiagnostic adhering to contract schema', () => {
      const err = new AuthError('Session expired for Bearer test_token_123', {
        details: {
          cookie: 'secret_cookie',
          token: 'secret_bearer',
          userId: 'user_123',
        },
      });

      const diag = toRedactedDiagnostic(err, 'corr_999', 'inst_mock_123');

      expect(diag.installationId).toBe('inst_mock_123');
      expect(diag.correlationId).toBe('corr_999');
      expect(diag.errorType).toBe('AUTH_ERROR');
      expect(diag.redactedDetails.message).not.toContain('test_token_123');
      expect(diag.redactedDetails.cookie).toBe('[REDACTED]');
      expect(diag.redactedDetails.token).toBe('[REDACTED]');
      expect(diag.redactedDetails.userId).toBe('user_123');

      // Passes runtime Zod validation
      expect(() => RedactedDiagnosticSchema.parse(diag)).not.toThrow();
    });
  });
});
