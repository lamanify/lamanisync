/**
 * Canonical Event Normalizer (Phase 7)
 * Transforms raw CMS records into canonical SyncEvent payloads.
 * Strictly adheres to AGENTS.md:
 * Rule 4: Zero passwords, cookies, or secrets transmitted.
 * Rule 6: No raw PHI stored in chrome.storage.local (SyncEvents are sent directly to Sync API).
 * Rule 9: Validate every message and remote manifest at runtime.
 */

import { type SyncEvent, SyncEventSchema } from './contracts/events.js';
import { normalizePatient, type NormalizedPatient } from './contracts/patient.js';
import { normalizeAppointment, type NormalizedAppointment } from './contracts/appointment.js';

export type EntitySyncType = 'patient' | 'appointment' | 'reference';

export interface PatientSyncEventOptions {
  occurredAt?: string;
  eventType?: string;
}

export interface AppointmentSyncEventOptions {
  occurredAt?: string;
  eventType?: string;
}

export interface ReferenceSyncEventOptions {
  occurredAt?: string;
  eventType?: string;
  revision?: number;
}

/**
 * Normalizes a raw patient record from CMS into a canonical SyncEvent.
 */
export function normalizePatientSyncEvent(
  raw: unknown,
  options: PatientSyncEventOptions = {}
): SyncEvent {
  const normalized: NormalizedPatient = normalizePatient(raw);
  const rawObj = raw as Record<string, unknown>;
  const revision = Number.isInteger(Number(rawObj.revision ?? rawObj.rev))
    ? Math.max(0, Number(rawObj.revision ?? rawObj.rev))
    : 1;

  const occurredAt = options.occurredAt || normalized.updatedAt || new Date().toISOString();
  const eventType = options.eventType || 'PATIENT_SYNCED';
  const eventId = `evt_patient_${normalized.id}_rev${revision}`;

  const event: SyncEvent = {
    eventId,
    entityType: 'patient',
    entityId: normalized.id,
    eventType,
    revision,
    occurredAt,
    payload: normalized as unknown as Record<string, unknown>,
  };

  return SyncEventSchema.parse(event);
}

/**
 * Normalizes a raw appointment record from CMS into a canonical SyncEvent.
 */
export function normalizeAppointmentSyncEvent(
  raw: unknown,
  options: AppointmentSyncEventOptions = {}
): SyncEvent {
  const normalized: NormalizedAppointment = normalizeAppointment(raw);
  const occurredAt = options.occurredAt || normalized.updatedAt || new Date().toISOString();
  const eventType = options.eventType || (
    normalized.status === 'cancelled'
      ? 'APPOINTMENT_CANCELLED'
      : 'APPOINTMENT_SYNCED'
  );
  const eventId = `evt_appointment_${normalized.id}_rev${normalized.revision}`;

  const event: SyncEvent = {
    eventId,
    entityType: 'appointment',
    entityId: normalized.id,
    eventType,
    revision: normalized.revision,
    occurredAt,
    payload: normalized as unknown as Record<string, unknown>,
  };

  return SyncEventSchema.parse(event);
}

/**
 * Normalizes reference data (provider, service, location) into a canonical SyncEvent.
 */
export function normalizeReferenceSyncEvent(
  referenceType: 'provider' | 'service' | 'location',
  raw: unknown,
  options: ReferenceSyncEventOptions = {}
): SyncEvent {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid reference data input: expected an object');
  }

  const r = raw as Record<string, unknown>;
  const id = String(r.id || '').trim();
  if (!id) {
    throw new Error(`Reference item of type '${referenceType}' is missing mandatory id`);
  }

  const occurredAt = options.occurredAt || new Date().toISOString();
  const revision = options.revision ?? 1;
  const eventType = options.eventType || `${referenceType.toUpperCase()}_SYNCED`;
  const eventId = `evt_${referenceType}_${id}_rev${revision}`;

  const event: SyncEvent = {
    eventId,
    entityType: 'reference',
    entityId: id,
    eventType,
    revision,
    occurredAt,
    payload: {
      referenceType,
      ...r,
    },
  };

  return SyncEventSchema.parse(event);
}
