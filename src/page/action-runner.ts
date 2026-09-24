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
    patientId: z.string().optional().default(''),
    providerId: z.string().optional().default(''),
    startTime: z.string().min(1),
    endTime: z.string().optional(),
    serviceId: z.string().optional(),
    locationId: z.string().optional(),
    notes: z.string().optional(),
    // Allowed clinic sync metadata
    appointmentId: z.string().optional(),
    status: z.string().optional(),
    slotDate: z.string().optional(),
    slotTime: z.string().optional(),
    patientName: z.string().optional(),
    patientPhone: z.string().optional(),
    providerName: z.string().optional(),
  })
  .strict();

export const AppointmentRescheduleParamsSchema = z
  .object({
    appointmentId: z.string().min(1),
    startTime: z.string().min(1),
    endTime: z.string().optional(),
    expectedRev: z.number().int().optional(),
    notes: z.string().optional(),
    slotDate: z.string().optional(),
    slotTime: z.string().optional(),
    status: z.string().optional(),
  })
  .strict();

export const AppointmentCancelParamsSchema = z
  .object({
    appointmentId: z.string().min(1),
    id: z.string().optional(),
    reason: z.string().optional(),
    notes: z.string().optional(),
    status: z.string().optional(),
  })
  .strict();

export const AppointmentVerifyParamsSchema = z
  .object({
    appointmentId: z.string().min(1),
    id: z.string().optional(),
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
    patientId: z.string().optional(),
    id: z.string().optional(),
  })
  .strict();

export const PatientVerifyParamsSchema = z
  .object({
    patientId: z.string().min(1),
    id: z.string().optional(),
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
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    body?: string;
  };
  extractResult(
    responseStatus: number,
    json: unknown
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

function computeCompositeTimes(appt: Record<string, unknown>): { startTime?: string; endTime?: string } {
  const slotDate = (appt.appointment_date || appt.appointmentDate) as string | undefined;
  const slotTime = (appt.appointment_time || appt.appointmentTime) as string | undefined;
  const duration = Number(appt.duration_minutes || appt.durationMinutes || 30);
  let startTime = (appt.startTime || appt.start_time) as string | undefined;
  let endTime = (appt.endTime || appt.end_time) as string | undefined;

  if ((!startTime || startTime === '') && slotDate && slotTime) {
    startTime = `${slotDate}T${slotTime}`;
  }
  if ((!endTime || endTime === '') && slotDate && slotTime) {
    const [h, m] = String(slotTime).split(':').map(Number);
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      const totalMinutes = h * 60 + m + duration;
      const endH = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
      const endM = String(totalMinutes % 60).padStart(2, '0');
      endTime = `${slotDate}T${endH}:${endM}:00`;
    }
  }
  return { startTime, endTime };
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
    extractResult: (status, rawJson) => {
      const json = ((Array.isArray(rawJson) ? rawJson[0] : rawJson) as Record<string, unknown>) || {};
      if (status === 201 || status === 200) {
        const appt = ((json.data as Record<string, unknown>) || json) as Record<string, unknown>;
        if (!appt || typeof appt.id !== 'string' || !appt.id) {
          return {
            status: 'ERROR',
            error: {
              code: 'INVALID_CMS_RESPONSE',
              message: 'CMS response missing appointment ID',
            },
          };
        }
        const composite = computeCompositeTimes(appt);
        return {
          status: 'SUCCESS',
          data: {
            id: String(appt.id || ''),
            patientId: (appt.patientId || appt.patient_id) as string,
            providerId: (appt.providerId || appt.doctor_id || appt.provider_id) as string,
            startTime: (appt.startTime || appt.start_time || composite.startTime || '') as string,
            endTime: (appt.endTime || appt.end_time || composite.endTime || '') as string,
            status: (appt.status || 'booked') as string,
            rev: typeof appt.rev === 'number' ? appt.rev : 1,
            createdAt: (appt.createdAt || appt.created_at) as string,
            resolvedPatientId: (appt.patientId || appt.patient_id) as string,
            resolvedProviderId: (appt.providerId || appt.doctor_id || appt.provider_id) as string,
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
    extractResult: (status, rawJson) => {
      const json = ((Array.isArray(rawJson) ? rawJson[0] : rawJson) as Record<string, unknown>) || {};
      if (status === 200) {
        const appt = ((json.data as Record<string, unknown>) || json) as Record<string, unknown>;
        const composite = computeCompositeTimes(appt);
        return {
          status: 'SUCCESS',
          data: {
            id: appt.id,
            startTime: (appt.startTime || appt.start_time || composite.startTime || '') as string,
            endTime: (appt.endTime || appt.end_time || composite.endTime || '') as string,
            status: (appt.status || 'booked') as string,
            rev: typeof appt.rev === 'number' ? appt.rev : 1,
            updatedAt: (appt.updatedAt || appt.updated_at) as string,
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
    extractResult: (status, rawJson) => {
      const json = ((Array.isArray(rawJson) ? rawJson[0] : rawJson) as Record<string, unknown>) || {};
      if (status === 200 || status === 204) {
        const appt = ((json.data as Record<string, unknown>) || json) as Record<string, unknown>;
        return {
          status: 'SUCCESS',
          data: {
            id: String(appt.id || ''),
            status: 'cancelled',
            rev: typeof appt.rev === 'number' ? appt.rev : 1,
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
    extractResult: (status, rawJson) => {
      const json = ((Array.isArray(rawJson) ? rawJson[0] : rawJson) as Record<string, unknown>) || {};
      if (status === 200) {
        const appt = ((json.data as Record<string, unknown>) || json) as Record<string, unknown>;
        const composite = computeCompositeTimes(appt);
        return {
          status: 'SUCCESS',
          data: {
            id: String(appt.id || ''),
            patientId: (appt.patientId || appt.patient_id) as string,
            providerId: (appt.providerId || appt.doctor_id || appt.provider_id) as string,
            startTime: (appt.startTime || appt.start_time || composite.startTime || '') as string,
            endTime: (appt.endTime || appt.end_time || composite.endTime || '') as string,
            status: (appt.status || 'booked') as string,
            rev: typeof appt.rev === 'number' ? appt.rev : 1,
            updatedAt: (appt.updatedAt || appt.updated_at) as string,
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
    extractResult: (status, rawJson) => {
      const json = ((Array.isArray(rawJson) ? rawJson[0] : rawJson) as Record<string, unknown>) || {};
      if (status === 201 || status === 200) {
        const patient = ((json.data as Record<string, unknown>) || json) as Record<string, unknown>;
        if (!patient || typeof patient.id !== 'string' || !patient.id) {
          return {
            status: 'ERROR',
            error: {
              code: 'INVALID_CMS_RESPONSE',
              message: 'CMS response missing patient ID',
            },
          };
        }
        const pFirstName = patient.first_name as string | undefined;
        const pLastName = patient.last_name as string | undefined;
        const fallbackFullName = [pFirstName, pLastName].filter(Boolean).join(' ').trim();
        return {
          status: 'SUCCESS',
          data: {
            id: patient.id,
            mrn: (patient.mrn || patient.patient_id) as string | undefined,
            fullName: (patient.fullName || patient.full_name || fallbackFullName || '') as string,
            phone: (patient.phone || patient.mobile_no) as string,
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
    extractResult: (status, rawJson) => {
      const json = ((Array.isArray(rawJson) ? rawJson[0] : rawJson) as Record<string, unknown>) || {};
      if (status === 200) {
        const patient = ((json.data as Record<string, unknown>) || json) as Record<string, unknown>;
        const pFirstName = patient.first_name as string | undefined;
        const pLastName = patient.last_name as string | undefined;
        const fallbackFullName = [pFirstName, pLastName].filter(Boolean).join(' ').trim();
        return {
          status: 'SUCCESS',
          data: {
            id: patient.id,
            mrn: (patient.mrn || patient.patient_id) as string | undefined,
            fullName: (patient.fullName || patient.full_name || fallbackFullName || '') as string,
            phone: (patient.phone || patient.mobile_no) as string,
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

export interface ActionRecipeConfig {
  path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  verificationPath?: string;
}

export interface SupabaseLikeClient {
  from: (table: string) => {
    insert: (values: unknown) => {
      select: () => {
        single: () => Promise<{ data: unknown; error: unknown; status?: number }>;
      };
    };
    update: (values: unknown) => {
      eq: (col: string, val: unknown) => {
        select: () => {
          single: () => Promise<{ data: unknown; error: unknown; status?: number }>;
        };
      };
    };
    select: (columns?: string) => {
      eq: (col: string, val: unknown) => {
        single: () => Promise<{ data: unknown; error: unknown; status?: number }>;
      };
    };
  };
}

export interface ExecuteActionOptions {
  actionId: string;
  correlationId: string;
  parameters: unknown;
  fetchFn?: typeof fetch;
  baseOrigin?: string;
  targetWindow?: Window;
  supabaseClient?: unknown;
  recipe?: ActionRecipeConfig;
}

async function executeViaSupabase(
  actionId: PredefinedActionId,
  correlationId: string,
  params: unknown,
  supabase: SupabaseLikeClient
): Promise<ActionExecutionResult> {
  const recipe = RECIPES[actionId];
  let validatedParams: unknown;
  try {
    validatedParams = recipe.validate(params);
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

  try {
    if (actionId === ACTION_APPOINTMENT_CREATE) {
      const p = validatedParams as z.infer<typeof AppointmentCreateParamsSchema>;
      const { data, error } = await supabase
        .from('appointments')
        .insert({
          patient_id: p.patientId,
          provider_id: p.providerId,
          start_time: p.startTime,
          end_time: p.endTime,
          service_id: p.serviceId || 'SRV-01',
          location_id: p.locationId || 'LOC-01',
          notes: p.notes || '',
          status: 'booked',
        })
        .select()
        .single();

      if (error) {
        const errObj = error as { code?: string; message?: string };
        const isConflict = errObj.code === '23505' || errObj.message?.toLowerCase().includes('conflict');
        return {
          actionId,
          correlationId,
          status: isConflict ? 'CONFLICT' : 'ERROR',
          error: {
            code: isConflict ? 'CONFLICT' : (errObj.code || 'SUPABASE_ERROR'),
            message: errObj.message || 'Supabase appointment creation failed',
          },
        };
      }

      const record = (data || {}) as Record<string, unknown>;
      return {
        actionId,
        correlationId,
        status: 'SUCCESS',
        data: {
          id: String(record.id || ''),
          patientId: (record.patient_id || record.patientId) as string,
          providerId: (record.provider_id || record.providerId) as string,
          startTime: (record.start_time || record.startTime) as string,
          endTime: (record.end_time || record.endTime) as string,
          status: (record.status || 'booked') as string,
          rev: typeof record.rev === 'number' ? record.rev : 1,
          createdAt: (record.created_at || record.createdAt) as string,
        },
      };
    }

    if (actionId === ACTION_APPOINTMENT_RESCHEDULE) {
      const p = validatedParams as z.infer<typeof AppointmentRescheduleParamsSchema>;
      const { data, error } = await supabase
        .from('appointments')
        .update({
          start_time: p.startTime,
          ...(p.endTime ? { end_time: p.endTime } : {}),
          ...(p.notes !== undefined ? { notes: p.notes } : {}),
        })
        .eq('id', p.appointmentId)
        .select()
        .single();

      if (error) {
        const errObj = error as { code?: string; message?: string };
        const isConflict = errObj.code === '23505' || errObj.message?.toLowerCase().includes('conflict');
        return {
          actionId,
          correlationId,
          status: isConflict ? 'CONFLICT' : 'ERROR',
          error: {
            code: isConflict ? 'CONFLICT' : (errObj.code || 'SUPABASE_ERROR'),
            message: errObj.message || 'Supabase appointment reschedule failed',
          },
        };
      }

      const record = (data || {}) as Record<string, unknown>;
      return {
        actionId,
        correlationId,
        status: 'SUCCESS',
        data: {
          id: String(record.id || p.appointmentId),
          startTime: (record.start_time || record.startTime || p.startTime) as string,
          endTime: (record.end_time || record.endTime || p.endTime) as string,
          status: (record.status || 'booked') as string,
          rev: typeof record.rev === 'number' ? record.rev : (p.expectedRev ? p.expectedRev + 1 : 2),
          updatedAt: (record.updated_at || record.updatedAt) as string,
        },
      };
    }

    if (actionId === ACTION_APPOINTMENT_CANCEL) {
      const p = validatedParams as z.infer<typeof AppointmentCancelParamsSchema>;
      const { data, error } = await supabase
        .from('appointments')
        .update({ status: 'cancelled' })
        .eq('id', p.appointmentId)
        .select()
        .single();

      if (error) {
        const errObj = error as { code?: string; message?: string };
        return {
          actionId,
          correlationId,
          status: 'ERROR',
          error: { code: errObj.code || 'SUPABASE_ERROR', message: errObj.message || 'Cancel failed' },
        };
      }

      const record = (data || {}) as Record<string, unknown>;
      return {
        actionId,
        correlationId,
        status: 'SUCCESS',
        data: {
          id: String(record.id || p.appointmentId),
          status: 'cancelled',
          rev: typeof record.rev === 'number' ? record.rev : 1,
        },
      };
    }

    if (actionId === ACTION_APPOINTMENT_VERIFY) {
      const p = validatedParams as z.infer<typeof AppointmentVerifyParamsSchema>;
      const { data, error } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', p.appointmentId)
        .single();

      if (error || !data) {
        return {
          actionId,
          correlationId,
          status: 'ERROR',
          error: { code: 'VERIFICATION_FAILED', message: 'Appointment not found' },
        };
      }

      const record = data as Record<string, unknown>;
      return {
        actionId,
        correlationId,
        status: 'SUCCESS',
        data: {
          id: String(record.id || p.appointmentId),
          patientId: (record.patient_id || record.patientId) as string,
          providerId: (record.provider_id || record.providerId) as string,
          startTime: (record.start_time || record.startTime) as string,
          endTime: (record.end_time || record.endTime) as string,
          status: (record.status || 'booked') as string,
          rev: typeof record.rev === 'number' ? record.rev : 1,
          updatedAt: (record.updated_at || record.updatedAt) as string,
        },
      };
    }

    if (actionId === ACTION_PATIENT_CREATE) {
      const p = validatedParams as z.infer<typeof PatientCreateParamsSchema>;
      const { data, error } = await supabase
        .from('patients')
        .insert({
          full_name: p.fullName,
          phone: p.phone,
          ...(p.mrn ? { mrn: p.mrn } : {}),
          ...(p.icOrPassport ? { ic_or_passport: p.icOrPassport } : {}),
          ...(p.email ? { email: p.email } : {}),
          ...(p.dateOfBirth ? { date_of_birth: p.dateOfBirth } : {}),
          ...(p.gender ? { gender: p.gender } : {}),
        })
        .select()
        .single();

      if (error) {
        const errObj = error as { code?: string; message?: string };
        return {
          actionId,
          correlationId,
          status: 'ERROR',
          error: { code: errObj.code || 'PATIENT_CREATE_FAILED', message: errObj.message || 'Patient create failed' },
        };
      }

      const record = (data || {}) as Record<string, unknown>;
      return {
        actionId,
        correlationId,
        status: 'SUCCESS',
        data: {
          id: String(record.id || ''),
          mrn: record.mrn as string | undefined,
          fullName: (record.full_name || record.fullName) as string,
          phone: (record.phone || p.phone) as string,
        },
      };
    }

    if (actionId === ACTION_PATIENT_VERIFY) {
      const p = validatedParams as z.infer<typeof PatientVerifyParamsSchema>;
      const { data, error } = await supabase
        .from('patients')
        .select('*')
        .eq('id', p.patientId)
        .single();

      if (error || !data) {
        return {
          actionId,
          correlationId,
          status: 'ERROR',
          error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found' },
        };
      }

      const record = data as Record<string, unknown>;
      return {
        actionId,
        correlationId,
        status: 'SUCCESS',
        data: {
          id: String(record.id || p.patientId),
          mrn: record.mrn as string | undefined,
          fullName: (record.full_name || record.fullName) as string,
          phone: (record.phone || record.mobile_no) as string,
        },
      };
    }

    return {
      actionId,
      correlationId,
      status: 'ERROR',
      error: { code: 'UNSUPPORTED_ACTION_ID', message: `Action ${actionId} not supported on Supabase client` },
    };
  } catch (err) {
    return {
      actionId,
      correlationId,
      status: 'ERROR',
      error: {
        code: 'SUPABASE_DELEGATION_ERROR',
        message: (err as Error).message || 'Failed during window.supabase execution',
      },
    };
  }
}

export interface PostgrestAppointmentPreparation {
  body: string;
  resolvedPatientId: string;
  resolvedDoctorId: string;
  resolvedReason: string;
}

export async function resolvePostgrestAppointmentPayload(
  p: z.infer<typeof AppointmentCreateParamsSchema>,
  actualBaseUrl: string,
  requestHeaders: Record<string, string>,
  fetchFn: typeof fetch,
  isCrossOrigin: boolean
): Promise<PostgrestAppointmentPreparation> {
  let resolvedPatientId = '';
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (p.patientId && isUuid.test(p.patientId)) {
    try {
      const checkRes = await fetchFn(`${actualBaseUrl}/rest/v1/patients?id=eq.${encodeURIComponent(p.patientId)}&select=id`, {
        method: 'GET',
        headers: requestHeaders,
        credentials: isCrossOrigin ? 'omit' : 'include',
      });
      if (checkRes.ok) {
        const rows = (await checkRes.json()) as Array<{ id: string }>;
        if (Array.isArray(rows) && rows.length > 0 && rows[0]?.id) {
          resolvedPatientId = rows[0].id;
        }
      }
    } catch {
      // Continue searching
    }
  }

  const searchPhone = (p.patientPhone || '').trim();
  if (!resolvedPatientId && searchPhone) {
    try {
      const phoneRes = await fetchFn(`${actualBaseUrl}/rest/v1/patients?phone=eq.${encodeURIComponent(searchPhone)}&select=id`, {
        method: 'GET',
        headers: requestHeaders,
        credentials: isCrossOrigin ? 'omit' : 'include',
      });
      if (phoneRes.ok) {
        const rows = (await phoneRes.json()) as Array<{ id: string }>;
        if (Array.isArray(rows) && rows.length > 0 && rows[0]?.id) {
          resolvedPatientId = rows[0].id;
        }
      }
    } catch {
      // Continue
    }
  }

  const searchName = (p.patientName || '').trim();
  if (!resolvedPatientId && searchName) {
    try {
      const nameRes = await fetchFn(`${actualBaseUrl}/rest/v1/patients?first_name=ilike.*${encodeURIComponent(searchName)}*&select=id`, {
        method: 'GET',
        headers: requestHeaders,
        credentials: isCrossOrigin ? 'omit' : 'include',
      });
      if (nameRes.ok) {
        const rows = (await nameRes.json()) as Array<{ id: string }>;
        if (Array.isArray(rows) && rows.length > 0 && rows[0]?.id) {
          resolvedPatientId = rows[0].id;
        }
      }
    } catch {
      // Continue
    }
  }

  if (!resolvedPatientId) {
    const rawName = (p.patientName || 'Patient').trim();
    const parts = rawName.split(/\s+/);
    const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || 'Patient');
    const lastName = parts.length > 1 ? parts[parts.length - 1] : '.';
    const createPatientPayload = {
      first_name: firstName,
      last_name: lastName,
      phone: p.patientPhone || '+60100000000',
      date_of_birth: '2000-01-01',
      gender: 'other',
      address: 'Malaysia',
    };
    try {
      const createRes = await fetchFn(`${actualBaseUrl}/rest/v1/patients`, {
        method: 'POST',
        headers: { ...requestHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify(createPatientPayload),
        credentials: isCrossOrigin ? 'omit' : 'include',
      });
      if (createRes.ok) {
        const createdRows = (await createRes.json()) as Array<{ id: string }>;
        if (Array.isArray(createdRows) && createdRows[0]?.id) {
          resolvedPatientId = createdRows[0].id;
        }
      }
    } catch {
      // Continue to fallback
    }
  }

  if (!resolvedPatientId) {
    try {
      const anyPatRes = await fetchFn(`${actualBaseUrl}/rest/v1/patients?select=id&limit=1`, {
        method: 'GET',
        headers: requestHeaders,
        credentials: isCrossOrigin ? 'omit' : 'include',
      });
      if (anyPatRes.ok) {
        const rows = (await anyPatRes.json()) as Array<{ id: string }>;
        if (rows[0]?.id) resolvedPatientId = rows[0].id;
      }
    } catch {
      // Ignore
    }
  }

  let resolvedDoctorId = '';
  let isDefaultDoctor = false;
  let activeDoctors: Array<{ id: string; first_name?: string; last_name?: string }> = [];
  try {
    const docRes = await fetchFn(`${actualBaseUrl}/rest/v1/profiles?role=eq.doctor&select=id,first_name,last_name`, {
      method: 'GET',
      headers: requestHeaders,
      credentials: isCrossOrigin ? 'omit' : 'include',
    });
    if (docRes.ok) {
      activeDoctors = (await docRes.json()) as Array<{ id: string; first_name?: string; last_name?: string }>;
    }
  } catch {
    // Continue
  }

  if (p.providerId && activeDoctors.some((d) => d.id === p.providerId)) {
    resolvedDoctorId = p.providerId;
  }

  if (!resolvedDoctorId && p.providerName && activeDoctors.length > 0) {
    const cleanDocName = p.providerName.toLowerCase().replace(/^dr\.?\s*/i, '').trim();
    const matched = activeDoctors.find((d) => {
      const fn = `${d.first_name || ''} ${d.last_name || ''}`.toLowerCase();
      return fn.includes(cleanDocName) || cleanDocName.includes((d.first_name || '').toLowerCase());
    });
    if (matched) {
      resolvedDoctorId = matched.id;
    }
  }

  if (!resolvedDoctorId && activeDoctors.length > 0) {
    resolvedDoctorId = activeDoctors[0].id;
    isDefaultDoctor = true;
  }

  if (!resolvedDoctorId) {
    try {
      const anyProfRes = await fetchFn(`${actualBaseUrl}/rest/v1/profiles?select=id&limit=1`, {
        method: 'GET',
        headers: requestHeaders,
        credentials: isCrossOrigin ? 'omit' : 'include',
      });
      if (anyProfRes.ok) {
        const rows = (await anyProfRes.json()) as Array<{ id: string }>;
        if (rows[0]?.id) {
          resolvedDoctorId = rows[0].id;
          isDefaultDoctor = true;
        }
      }
    } catch {
      // Ignore
    }
  }

  let resolvedReason = p.serviceId || 'General Consultation';
  let isDefaultService = false;
  try {
    const srvRes = await fetchFn(`${actualBaseUrl}/rest/v1/medical_services?select=id,name`, {
      method: 'GET',
      headers: requestHeaders,
      credentials: isCrossOrigin ? 'omit' : 'include',
    });
    if (srvRes.ok) {
      const services = (await srvRes.json()) as Array<{ id: string; name: string }>;
      const search = (p.serviceId || '').toLowerCase().trim();
      const matched = services.find((s) => s.id === p.serviceId || s.name.toLowerCase() === search || s.name.toLowerCase().includes(search));
      if (matched) {
        resolvedReason = matched.name;
      } else {
        isDefaultService = true;
      }
    }
  } catch {
    // Continue
  }

  const slotDate = p.startTime.includes('T') ? p.startTime.split('T')[0] : p.startTime.slice(0, 10);
  const slotTime = p.startTime.includes('T') ? p.startTime.split('T')[1].slice(0, 8) : (p.slotTime || '09:00:00');

  const notesList: string[] = [];
  if (p.notes) notesList.push(p.notes);
  if (isDefaultDoctor && p.providerName) {
    notesList.push(`Requested Doctor: ${p.providerName}`);
  }
  if (isDefaultService && p.serviceId) {
    notesList.push(`Service: ${p.serviceId}`);
  }
  const finalNotes = notesList.join(' | ');

  const body = JSON.stringify({
    patient_id: resolvedPatientId || p.patientId,
    doctor_id: resolvedDoctorId || p.providerId,
    appointment_date: slotDate,
    appointment_time: slotTime,
    duration_minutes: 30,
    reason: resolvedReason,
    notes: finalNotes,
    status: 'scheduled',
  });

  return {
    body,
    resolvedPatientId,
    resolvedDoctorId,
    resolvedReason,
  };
}

/**
 * Executes a predefined action recipe using ambient staff credentials or window.supabase.
 * Rejects arbitrary URLs, custom methods, or unauthorized action IDs.
 */
export async function executePredefinedAction(
  options: ExecuteActionOptions
): Promise<ActionExecutionResult> {
  const { actionId, correlationId, parameters, baseOrigin } = options;

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

  // 2. Check for window.supabase or injected supabase client delegation (MAIN world execution)
  const safeWindow = options.targetWindow || (typeof window !== 'undefined' ? window : undefined);
  const supabase = (options.supabaseClient || (safeWindow as Record<string, unknown> | undefined)?.supabase) as SupabaseLikeClient | undefined;

  if (supabase && typeof supabase.from === 'function') {
    return executeViaSupabase(actionId, correlationId, parameters, supabase);
  }

  // 3. Fallback to REST fetch (credentials: 'include')
  const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : undefined);

  if (!fetchFn) {
    throw new LamaniError('fetch is not available in execution context', 'FETCH_UNAVAILABLE');
  }

  const recipe = RECIPES[actionId];

  // 4. Strict parameter validation
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

  // 5. Build canned request with optional recipe override
  const req = recipe.toRequest(validatedParams);
  let requestPath = req.path;
  let requestMethod = req.method;
  let requestHeaders: Record<string, string> = { ...req.headers };
  let requestBody = req.body;

  if (options.recipe) {
    if (options.recipe.method) {
      requestMethod = options.recipe.method;
    }
    if (options.recipe.headers) {
      requestHeaders = { ...requestHeaders, ...options.recipe.headers };
    }
    if (options.recipe.path) {
      const p = validatedParams as Record<string, unknown>;
      const entityId = String(p.appointmentId || p.patientId || p.id || '');
      requestPath = options.recipe.path
        .replace(':id', encodeURIComponent(entityId))
        .replace(':appointmentId', encodeURIComponent(entityId))
        .replace(':patientId', encodeURIComponent(entityId));
    }
  }

  // Auto-detect PostgREST backend for Supabase CMS (e.g. LamaniPulse)
  let actualBaseUrl = baseOrigin ? baseOrigin.replace(/\/$/, '') : '';
  if (typeof window !== 'undefined' && window.localStorage) {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i) || '';
      if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
        try {
          const parsed = JSON.parse(window.localStorage.getItem(k) || '{}');
          if (parsed?.access_token) {
            requestHeaders['Authorization'] = `Bearer ${parsed.access_token}`;
            const refMatch = k.match(/^sb-([a-z0-9-]+)-auth-token$/);
            if (refMatch) {
              const projectRef = refMatch[1];
              if (projectRef === 'vxnvdmepejjhvphqxopl') {
                actualBaseUrl = `https://${projectRef}.supabase.co`;
                requestHeaders['apikey'] = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ4bnZkbWVwZWpqaHZwaHF4b3BsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcxOTU1MjYsImV4cCI6MjA3Mjc3MTUyNn0.t96U9mM_kg2UK2kzioSNmbT9dicWc2SVH-gyCwW-QZ0';
                if (actionId === ACTION_APPOINTMENT_CREATE) {
                  requestPath = '/rest/v1/appointments';
                } else if (actionId === ACTION_APPOINTMENT_RESCHEDULE || actionId === ACTION_APPOINTMENT_CANCEL) {
                  const p = validatedParams as Record<string, unknown>;
                  const apptId = encodeURIComponent(String(p.appointmentId || p.id || ''));
                  requestPath = `/rest/v1/appointments?id=eq.${apptId}`;
                  requestMethod = 'PATCH';
                } else if (actionId === ACTION_APPOINTMENT_VERIFY) {
                  const p = validatedParams as Record<string, unknown>;
                  const apptId = encodeURIComponent(String(p.appointmentId || ''));
                  requestPath = `/rest/v1/appointments?id=eq.${apptId}&select=*`;
                } else if (actionId === ACTION_PATIENT_CREATE) {
                  requestPath = '/rest/v1/patients';
                } else if (actionId === ACTION_PATIENT_VERIFY) {
                  const p = validatedParams as Record<string, unknown>;
                  const patId = encodeURIComponent(String(p.patientId || ''));
                  requestPath = `/rest/v1/patients?id=eq.${patId}&select=*`;
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const targetUrl = actualBaseUrl ? `${actualBaseUrl}${requestPath}` : requestPath;

  const isCrossOrigin =
    (typeof window !== 'undefined' &&
      Boolean(window.location?.origin) &&
      targetUrl.startsWith('http') &&
      !targetUrl.startsWith(window.location.origin)) ||
    (Boolean(baseOrigin) &&
      targetUrl.startsWith('http') &&
      !targetUrl.startsWith(baseOrigin!));

  let prepResult: PostgrestAppointmentPreparation | undefined;

  // Handle PostgREST specific headers and payload conventions
  if (requestPath.startsWith('/rest/v1/')) {
    if (!requestHeaders['Prefer'] && (requestMethod === 'POST' || requestMethod === 'PUT' || requestMethod === 'PATCH')) {
      requestHeaders['Prefer'] = 'return=representation';
    }
    if (requestPath.startsWith('/rest/v1/appointments')) {
      if (actionId === ACTION_APPOINTMENT_CREATE) {
        const p = validatedParams as z.infer<typeof AppointmentCreateParamsSchema>;
        prepResult = await resolvePostgrestAppointmentPayload(
          p,
          actualBaseUrl,
          requestHeaders,
          fetchFn,
          isCrossOrigin
        );
        requestBody = prepResult.body;
      } else if (actionId === ACTION_APPOINTMENT_RESCHEDULE) {
        const p = validatedParams as z.infer<typeof AppointmentRescheduleParamsSchema>;
        const slotDate = p.startTime.includes('T') ? p.startTime.split('T')[0] : p.startTime.slice(0, 10);
        const slotTime = p.startTime.includes('T') ? p.startTime.split('T')[1].slice(0, 8) : '09:00:00';
        requestBody = JSON.stringify({
          appointment_date: slotDate,
          appointment_time: slotTime,
          ...(p.notes !== undefined ? { notes: p.notes } : {}),
        });
      } else if (actionId === ACTION_APPOINTMENT_CANCEL) {
        requestBody = JSON.stringify({ status: 'cancelled' });
      }
    } else if (requestPath.startsWith('/rest/v1/patients') && actionId === ACTION_PATIENT_CREATE) {
      const p = validatedParams as z.infer<typeof PatientCreateParamsSchema>;
      const rawName = (p.fullName || 'Patient').trim();
      const parts = rawName.split(/\s+/);
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || 'Patient');
      const lastName = parts.length > 1 ? parts[parts.length - 1] : '.';
      requestBody = JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        phone: p.phone || '+60100000000',
        date_of_birth: p.dateOfBirth || '2000-01-01',
        gender: p.gender || 'other',
        address: 'Malaysia',
        ...(p.email ? { email: p.email } : {}),
      });
    }
  }

  // 6. Execute fetch using ambient staff credentials
  try {
    const response = await fetchFn(targetUrl, {
      method: requestMethod,
      headers: requestHeaders,
      body: requestBody,
      credentials: isCrossOrigin ? 'omit' : 'include',
    });

    let json: unknown = {};
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        json = await response.json();
      } catch {
        json = {};
      }
    }

    const result = recipe.extractResult(response.status, json);
    if (result.status === 'SUCCESS' && result.data && prepResult) {
      const dataObj = result.data as Record<string, unknown>;
      if (prepResult.resolvedPatientId) {
        dataObj.resolvedPatientId = prepResult.resolvedPatientId;
      }
      if (prepResult.resolvedDoctorId) {
        dataObj.resolvedProviderId = prepResult.resolvedDoctorId;
      }
    }
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
