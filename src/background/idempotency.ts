/**
 * Idempotency & Search-Before-Retry Resolver (Phase 8)
 * Prevents duplicate writes on transient failures by inspecting target CMS state
 * before re-issuing mutations.
 * Conforms to AGENTS.md:
 * Rule 4: Never transmit CMS secrets.
 * Rule 10: Reads must precede confirmation.
 */

import { areValuesEquivalent } from '../core/verification.js';

export interface IdempotencyResolverOptions {
  fetchFn?: typeof fetch;
  targetOrigin: string;
}

export interface IdempotencyCheckResult {
  isIdempotentMatch: boolean;
  existingRecord?: Record<string, unknown>;
  isConflict: boolean;
  reason?: string;
}

export class IdempotencyResolver {
  private fetchFn: typeof fetch;
  private targetOrigin: string;

  constructor(options: IdempotencyResolverOptions) {
    this.fetchFn = options.fetchFn || ((...args) => globalThis.fetch(...args));
    this.targetOrigin = options.targetOrigin.replace(/\/$/, '');
  }

  setTargetOrigin(origin: string): void {
    this.targetOrigin = origin.replace(/\/$/, '');
  }

  setFetchFn(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  /**
   * Search CMS for an existing appointment matching the specified criteria.
   * Prevents creating duplicate records if previous write succeeded server-side.
   */
  async searchExistingAppointment(criteria: {
    appointmentId?: string;
    patientId?: string;
    providerId?: string;
    startTime?: string;
  }): Promise<Record<string, unknown> | null> {
    // 1. Direct query by ID if known
    if (criteria.appointmentId) {
      try {
        const res = await this.fetchFn(`${this.targetOrigin}/api/appointments/${encodeURIComponent(criteria.appointmentId)}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        if (res.ok) {
          const json = (await res.json()) as Record<string, unknown>;
          return ((json.data as Record<string, unknown>) || json) ?? null;
        }
      } catch {
        // continue to general search
      }
    }

    // 2. Query appointment list by provider and date
    if (criteria.providerId && criteria.startTime) {
      try {
        const dateStr = criteria.startTime.split('T')[0];
        const res = await this.fetchFn(
          `${this.targetOrigin}/api/appointments?providerId=${encodeURIComponent(criteria.providerId)}&startDate=${encodeURIComponent(dateStr)}`,
          {
            method: 'GET',
            headers: { Accept: 'application/json' },
            credentials: 'include',
          }
        );

        if (res.ok) {
          const json = (await res.json()) as Record<string, unknown>;
          const appts = (Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []) as Array<Record<string, unknown>>;

          const match = appts.find((a) => {
            if (a.status === 'cancelled') return false;
            const timeMatches = areValuesEquivalent(a.startTime, criteria.startTime);
            const patientMatches = criteria.patientId ? areValuesEquivalent(a.patientId, criteria.patientId) : true;
            return timeMatches && patientMatches;
          });

          if (match) {
            return match;
          }
        }
      } catch {
        // network or search failure
      }
    }

    return null;
  }

  /**
   * Search CMS for an existing patient matching the specified criteria.
   */
  async searchExistingPatient(criteria: {
    patientId?: string;
    fullName?: string;
    phone?: string;
  }): Promise<Record<string, unknown> | null> {
    if (criteria.patientId) {
      try {
        const res = await this.fetchFn(`${this.targetOrigin}/api/patients/${encodeURIComponent(criteria.patientId)}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        if (res.ok) {
          const json = (await res.json()) as Record<string, unknown>;
          return ((json.data as Record<string, unknown>) || json) ?? null;
        }
      } catch {
        // fallback to query
      }
    }

    if (criteria.phone || criteria.fullName) {
      try {
        const query = criteria.phone || criteria.fullName || '';
        const res = await this.fetchFn(`${this.targetOrigin}/api/patients?q=${encodeURIComponent(query)}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        if (res.ok) {
          const json = (await res.json()) as Record<string, unknown>;
          const patients = (Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []) as Array<Record<string, unknown>>;

          const match = patients.find((p) => {
            if (criteria.phone && !areValuesEquivalent(p.phone, criteria.phone)) return false;
            if (criteria.fullName && !areValuesEquivalent(p.fullName, criteria.fullName)) return false;
            return true;
          });

          if (match) {
            return match;
          }
        }
      } catch {
        // ignore
      }
    }

    return null;
  }

  /**
   * Pre-flight slot availability check before booking.
   */
  async checkSlotAvailability(
    providerId: string,
    startTime: string
  ): Promise<{ available: boolean; reason?: string }> {
    const dateStr = startTime.split('T')[0];
    try {
      const url = `${this.targetOrigin}/api/appointments/availability?providerId=${encodeURIComponent(providerId)}&date=${encodeURIComponent(dateStr)}`;
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });

      if (!res.ok) {
        return { available: true }; // If availability endpoint not implemented/accessible, fail open to write
      }

      const json = (await res.json()) as Record<string, unknown>;
      const slots = (json.slots || json.data) as Array<{ startTime: string; available: boolean }> | undefined;

      if (Array.isArray(slots)) {
        const targetSlot = slots.find((s) => areValuesEquivalent(s.startTime, startTime));
        if (targetSlot) {
          return {
            available: Boolean(targetSlot.available),
            reason: targetSlot.available ? undefined : `Slot at ${startTime} is already booked`,
          };
        }
      }

      return { available: true };
    } catch {
      return { available: true }; // Network fallback
    }
  }

  /**
   * Resolves whether a 409 Conflict represents an idempotent retry success
   * or a genuine clash with external staff activity.
   */
  async resolveConflict(
    action: string,
    params: Record<string, unknown>,
    errorDetails?: Record<string, unknown>
  ): Promise<IdempotencyCheckResult> {
    const normAction = action.toUpperCase().replace(/^ACTION_/, '').replace(/-/g, '_');

    if (normAction === 'CREATE_APPOINTMENT' || normAction === 'APPOINTMENT_CREATE') {
      const existingId = (errorDetails?.existingAppointmentId as string | undefined) || undefined;
      const existing = await this.searchExistingAppointment({
        appointmentId: existingId,
        patientId: params.patientId as string | undefined,
        providerId: params.providerId as string | undefined,
        startTime: params.startTime as string | undefined,
      });

      if (existing) {
        // Check if existing record belongs to the same patient
        const patientIdMatches = areValuesEquivalent(existing.patientId, params.patientId);
        if (patientIdMatches && existing.status !== 'cancelled') {
          return {
            isIdempotentMatch: true,
            existingRecord: existing,
            isConflict: false,
          };
        }
      }

      return {
        isIdempotentMatch: false,
        isConflict: true,
        reason: (errorDetails?.message as string) || `Slot clash on provider ${String(params.providerId)} at ${String(params.startTime)}`,
      };
    }

    if (normAction === 'RESCHEDULE_APPOINTMENT' || normAction === 'APPOINTMENT_RESCHEDULE') {
      const apptId = (params.appointmentId || params.id) as string | undefined;
      if (apptId) {
        const existing = await this.searchExistingAppointment({ appointmentId: apptId });
        if (existing) {
          // If the appointment already has the requested startTime, it already succeeded!
          if (areValuesEquivalent(existing.startTime, params.startTime) && existing.status !== 'cancelled') {
            return {
              isIdempotentMatch: true,
              existingRecord: existing,
              isConflict: false,
            };
          }
        }
      }

      return {
        isIdempotentMatch: false,
        isConflict: true,
        reason: (errorDetails?.message as string) || 'Revision mismatch or concurrent reschedule conflict',
      };
    }

    if (normAction === 'CANCEL_APPOINTMENT' || normAction === 'APPOINTMENT_CANCEL') {
      const apptId = (params.appointmentId || params.id) as string | undefined;
      if (apptId) {
        const existing = await this.searchExistingAppointment({ appointmentId: apptId });
        if (existing && existing.status === 'cancelled') {
          return {
            isIdempotentMatch: true,
            existingRecord: existing,
            isConflict: false,
          };
        }
      }
    }

    return {
      isIdempotentMatch: false,
      isConflict: true,
      reason: (errorDetails?.message as string) || 'CMS concurrency conflict',
    };
  }
}
