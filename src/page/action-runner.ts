/**
 * Predefined Action Runner (Phase 5)
 * Executes canned, allowlisted CMS actions using ambient staff session credentials.
 * Strictly adheres to AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, bearer tokens, or CSRF secrets.
 * Rule 8: Page-world code may execute only predefined adapter action IDs—never arbitrary remote URL/method/body instructions.
 * Rule 10: An appointment is not confirmed until the CMS write is read back and verified.
 */

import { z } from 'zod';
import { LamaniError } from '../core/errors.js';

export const ACTION_APPOINTMENT_CREATE = 'ACTION_APPOINTMENT_CREATE' as const;
export const ACTION_APPOINTMENT_RESCHEDULE = 'ACTION_APPOINTMENT_RESCHEDULE' as const;
export const ACTION_APPOINTMENT_CANCEL = 'ACTION_APPOINTMENT_CANCEL' as const;
export const ACTION_APPOINTMENT_VERIFY = 'ACTION_APPOINTMENT_VERIFY' as const;
export const ACTION_PATIENT_CREATE = 'ACTION_PATIENT_CREATE' as const;
export const ACTION_PATIENT_VERIFY = 'ACTION_PATIENT_VERIFY' as const;

export const ALLOWLISTED_ACTION_IDS = [
  ACTION_APPOINTMENT_CREATE,
  ACTION_APPOINTMENT_RESCHEDULE,
  ACTION_APPOINTMENT_CANCEL,
  ACTION_APPOINTMENT_VERIFY,
  ACTION_PATIENT_CREATE,
  ACTION_PATIENT_VERIFY,
] as const;

export type PredefinedActionId = typeof ALLOWLISTED_ACTION_IDS[number];

export function isAllowlistedActionId(actionId: string): actionId is PredefinedActionId {
  return (ALLOWLISTED_ACTION_IDS as readonly string[]).includes(actionId);
}

// --- Action Parameters Schemas (strictly no arbitrary URL or method permitted) ---

export const AppointmentCreateParamsSchema = z
  .object({
    patientId: z.string().min(1),
    providerId: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().min(1),
    serviceId: z.string().optional(),
    locationId: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const AppointmentRescheduleParamsSchema = z
  .object({
    appointmentId: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().optional(),
    expectedRev: z.number().int().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const AppointmentCancelParamsSchema = z
  .object({
    appointmentId: z.string().min(1),
  })
  .strict();

export const AppointmentVerifyParamsSchema = z
  .object({
    appointmentId: z.string().min(1),
  })
  .strict();

export const PatientCreateParamsSchema = z
  .object({
    fullName: z.string().min(1),
    phone: z.string().min(1),
    mrn: z.string().optional(),
    icOrPassport: z.string().optional(),
    email: z.string().optional(),
    dateOfBirth: z.string().optional(),
    gender: z.string().optional(),
  })
  .strict();

export const PatientVerifyParamsSchema = z
  .object({
    patientId: z.string().min(1),
  })
  .strict();

export type ActionExecutionStatus = 'SUCCESS' | 'CONFLICT' | 'RATE_LIMITED' | 'ERROR';

export interface ActionExecutionResult {
  actionId: PredefinedActionId;
  correlationId: string;
  status: ActionExecutionStatus;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

interface ActionRecipe {
  validate(params: unknown): unknown;
  toRequest(params: unknown): {
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers?: Record<string, string>;
    body?: string;
  };
  extractResult(
    responseStatus: number,
    json: Record<string, unknown>
  ): {
    status: ActionExecutionStatus;
    data?: unknown;
    error?: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  };
}

// Canned recipe definitions: 100% hardcoded paths, methods, and sanitized extraction
const RECIPES: Record<PredefinedActionId, ActionRecipe> = {
  [ACTION_APPOINTMENT_CREATE]: {
    validate: (p) => AppointmentCreateParamsSchema.parse(p),
    toRequest: (rawParams) => {
      const params = rawParams as z.infer<typeof AppointmentCreateParamsSchema>;
      return {
        path: '/api/appointments',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId: params.patientId,
          providerId: params.providerId,
          startTime: params.startTime,
          endTime: params.endTime,
          serviceId: params.serviceId || 'SRV-01',
          locationId: params.locationId || 'LOC-01',
          notes: params.notes || '',
        }),
      };
    },
    extractResult: (status, json) => {
      if (status === 201 || status === 200) {
        const appt = (json.data as Record<string, unknown>) || json;
        return {
          status: 'SUCCESS',
          data: {
            id: appt.id,
            patientId: appt.patientId,
            providerId: appt.providerId,
            startTime: appt.startTime,
            endTime: appt.endTime,
            status: appt.status,
            rev: typeof appt.rev === 'number' ? appt.rev : 1,
            createdAt: appt.createdAt,
          },
        };
      }
      if (status === 409) {
        return {
          status: 'CONFLICT',
          error: {
            code: 'CONFLICT',
            message: (json.message as string) || 'Appointment slot conflict or double booking',
            details: { existingAppointmentId: json.existingAppointmentId as string },
          },
        };
      }
      if (status === 429) {
        return {
          status: 'RATE_LIMITED',
          error: { code: 'RATE_LIMITED', message: (json.message as string) || 'CMS rate limit exceeded' },
        };
      }
      return {
        status: 'ERROR',
        error: { code: 'CMS_REQUEST_FAILED', message: (json.message as string) || `CMS error status ${status}` },
      };
    },
  },

  [ACTION_APPOINTMENT_RESCHEDULE]: {
    validate: (p) => AppointmentRescheduleParamsSchema.parse(p),
    toRequest: (rawParams) => {
      const params = rawParams as z.infer<typeof AppointmentRescheduleParamsSchema>;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (params.expectedRev !== undefined) {
        headers['If-Match'] = String(params.expectedRev);
      }
      return {
        path: `/api/appointments/${encodeURIComponent(params.appointmentId)}`,
        method: 'PUT',
        headers,
        body: JSON.stringify({
          startTime: params.startTime,
          endTime: params.endTime,
          expectedRev: params.expectedRev,
          notes: params.notes,
        }),
      };
    },
    extractResult: (status, json) => {
      if (status === 200) {
        const appt = (json.data as Record<string, unknown>) || json;
        return {
          status: 'SUCCESS',
          data: {
            id: appt.id,
            startTime: appt.startTime,
            endTime: appt.endTime,
            status: appt.status,
            rev: appt.rev,
            updatedAt: appt.updatedAt,
          },
        };
      }
      if (status === 409) {
        return {
          status: 'CONFLICT',
          error: {
            code: 'CONFLICT',
            message: (json.message as string) || 'Revision conflict or slot collision',
            details: { currentRev: json.currentRev, existingAppointmentId: json.existingAppointmentId },
          },
        };
      }
      if (status === 429) {
        return {
          status: 'RATE_LIMITED',
          error: { code: 'RATE_LIMITED', message: (json.message as string) || 'CMS rate limit exceeded' },
        };
      }
      return {
        status: 'ERROR',
        error: { code: 'CMS_REQUEST_FAILED', message: (json.message as string) || `CMS error status ${status}` },
      };
    },
  },

  [ACTION_APPOINTMENT_CANCEL]: {
    validate: (p) => AppointmentCancelParamsSchema.parse(p),
    toRequest: (rawParams) => {
      const params = rawParams as z.infer<typeof AppointmentCancelParamsSchema>;
      return {
        path: `/api/appointments/${encodeURIComponent(params.appointmentId)}`,
        method: 'DELETE',
      };
    },
    extractResult: (status, json) => {
      if (status === 200) {
        const appt = (json.data as Record<string, unknown>) || json;
        return {
          status: 'SUCCESS',
          data: {
            id: appt.id,
            status: 'cancelled',
            rev: appt.rev,
          },
        };
      }
      return {
        status: 'ERROR',
        error: { code: 'CMS_REQUEST_FAILED', message: (json.message as string) || `CMS error status ${status}` },
      };
    },
  },

  [ACTION_APPOINTMENT_VERIFY]: {
    validate: (p) => AppointmentVerifyParamsSchema.parse(p),
    toRequest: (rawParams) => {
      const params = rawParams as z.infer<typeof AppointmentVerifyParamsSchema>;
      return {
        path: `/api/appointments/${encodeURIComponent(params.appointmentId)}`,
        method: 'GET',
      };
    },
    extractResult: (status, json) => {
      if (status === 200) {
        const appt = (json.data as Record<string, unknown>) || json;
        return {
          status: 'SUCCESS',
          data: {
            id: appt.id,
            patientId: appt.patientId,
            providerId: appt.providerId,
            startTime: appt.startTime,
            endTime: appt.endTime,
            status: appt.status,
            rev: appt.rev,
            updatedAt: appt.updatedAt,
          },
        };
      }
      return {
        status: 'ERROR',
        error: { code: 'VERIFICATION_FAILED', message: `Appointment verification failed with status ${status}` },
      };
    },
  },

  [ACTION_PATIENT_CREATE]: {
    validate: (p) => PatientCreateParamsSchema.parse(p),
    toRequest: (rawParams) => ({
      path: '/api/patients',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rawParams),
    }),
    extractResult: (status, json) => {
      if (status === 201 || status === 200) {
        const patient = (json.data as Record<string, unknown>) || json;
        return {
          status: 'SUCCESS',
          data: {
            id: patient.id,
            mrn: patient.mrn,
            fullName: patient.fullName,
            phone: patient.phone,
          },
        };
      }
      return {
        status: 'ERROR',
        error: { code: 'PATIENT_CREATE_FAILED', message: (json.message as string) || `Status ${status}` },
      };
    },
  },

  [ACTION_PATIENT_VERIFY]: {
    validate: (p) => PatientVerifyParamsSchema.parse(p),
    toRequest: (rawParams) => {
      const params = rawParams as z.infer<typeof PatientVerifyParamsSchema>;
      return {
        path: `/api/patients/${encodeURIComponent(params.patientId)}`,
        method: 'GET',
      };
    },
    extractResult: (status, json) => {
      if (status === 200) {
        const patient = (json.data as Record<string, unknown>) || json;
        return {
          status: 'SUCCESS',
          data: {
            id: patient.id,
            mrn: patient.mrn,
            fullName: patient.fullName,
            phone: patient.phone,
          },
        };
      }
      return {
        status: 'ERROR',
        error: { code: 'PATIENT_NOT_FOUND', message: `Status ${status}` },
      };
    },
  },
};

export interface ExecuteActionOptions {
  actionId: string;
  correlationId: string;
  parameters: unknown;
  fetchFn?: typeof fetch;
  baseOrigin?: string;
}

/**
 * Executes a predefined action recipe using ambient staff credentials.
 * Rejects arbitrary URLs, custom methods, or unauthorized action IDs.
 */
export async function executePredefinedAction(
  options: ExecuteActionOptions
): Promise<ActionExecutionResult> {
  const { actionId, correlationId, parameters, baseOrigin } = options;
  const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : undefined);

  if (!fetchFn) {
    throw new LamaniError('fetch is not available in execution context', 'FETCH_UNAVAILABLE');
  }

  // 1. Strict allowlist check (AGENTS.md Rule 8)
  if (!isAllowlistedActionId(actionId)) {
    return {
      actionId: actionId as PredefinedActionId,
      correlationId,
      status: 'ERROR',
      error: {
        code: 'UNSUPPORTED_ACTION_ID',
        message: `Action ID '${actionId}' is not in the predefined allowlist. Arbitrary executions are strictly forbidden.`,
      },
    };
  }

  const recipe = RECIPES[actionId];

  // 2. Strict parameter validation
  let validatedParams: unknown;
  try {
    validatedParams = recipe.validate(parameters);
  } catch (err) {
    return {
      actionId,
      correlationId,
      status: 'ERROR',
      error: {
        code: 'INVALID_ACTION_PARAMETERS',
        message: (err as Error).message || 'Invalid parameters for action recipe',
      },
    };
  }

  // 3. Build canned request (Zero arbitrary URL/method input allowed)
  const req = recipe.toRequest(validatedParams);
  const targetUrl = baseOrigin ? `${baseOrigin.replace(/\/$/, '')}${req.path}` : req.path;

  // 4. Execute fetch using ambient staff credentials
  try {
    const response = await fetchFn(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      credentials: 'include', // ambient browser session
    });

    let json: Record<string, unknown> = {};
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        json = (await response.json()) as Record<string, unknown>;
      } catch {
        json = {};
      }
    }

    const result = recipe.extractResult(response.status, json);
    return {
      actionId,
      correlationId,
      status: result.status,
      data: result.data,
      error: result.error,
    };
  } catch (err) {
    return {
      actionId,
      correlationId,
      status: 'ERROR',
      error: {
        code: 'CMS_NETWORK_ERROR',
        message: (err as Error).message || 'Failed to execute canned action fetch',
      },
    };
  }
}
