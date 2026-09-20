// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  normalizePatientSyncEvent,
  normalizeAppointmentSyncEvent,
  normalizeReferenceSyncEvent,
} from '../../src/core/event-normalizer.js';
import { SyncEventSchema } from '../../src/core/contracts/events.js';

describe('Event Normalizer (Phase 7)', () => {
  it('transforms raw patient record into a valid canonical SyncEvent', () => {
    const rawPatient = {
      id: 'ZZTEST-P01',
      mrn: 'MRN-ZZ-001',
      fullName: 'ZZTEST Patient 01',
      phone: '+60 12-345 6701',
      gender: 'female',
      dateOfBirth: '1990-01-01',
      revision: 2,
    };

    const event = normalizePatientSyncEvent(rawPatient);
    expect(event.entityType).toBe('patient');
    expect(event.entityId).toBe('ZZTEST-P01');
    expect(event.eventType).toBe('PATIENT_SYNCED');
    expect(event.revision).toBe(2);
    expect(event.eventId).toBe('evt_patient_ZZTEST-P01_rev2');
    expect(event.payload.phone).toBe('+60123456701');

    // Runtime schema validation
    expect(() => SyncEventSchema.parse(event)).not.toThrow();
  });

  it('transforms raw appointment record into a valid canonical SyncEvent', () => {
    const rawAppointment = {
      id: 'APT-001',
      patientId: 'ZZTEST-P01',
      providerId: 'DOC-01',
      serviceId: 'SRV-01',
      locationId: 'LOC-01',
      startTime: '2026-10-01T09:00:00+08:00',
      endTime: '2026-10-01T09:15:00+08:00',
      status: 'booked',
      rev: 3,
    };

    const event = normalizeAppointmentSyncEvent(rawAppointment);
    expect(event.entityType).toBe('appointment');
    expect(event.entityId).toBe('APT-001');
    expect(event.eventType).toBe('APPOINTMENT_SYNCED');
    expect(event.revision).toBe(3);
    expect(event.eventId).toBe('evt_appointment_APT-001_rev3');

    // Runtime schema validation
    expect(() => SyncEventSchema.parse(event)).not.toThrow();
  });

  it('sets eventType to APPOINTMENT_CANCELLED when status is cancelled', () => {
    const cancelledAppt = {
      id: 'APT-002',
      patientId: 'ZZTEST-P02',
      providerId: 'DOC-02',
      serviceId: 'SRV-02',
      startTime: '2026-10-01T10:00:00+08:00',
      endTime: '2026-10-01T10:30:00+08:00',
      status: 'cancelled',
      rev: 2,
    };

    const event = normalizeAppointmentSyncEvent(cancelledAppt);
    expect(event.eventType).toBe('APPOINTMENT_CANCELLED');
    expect(event.revision).toBe(2);
  });

  it('transforms reference data into valid canonical SyncEvents', () => {
    const provider = { id: 'DOC-01', fullName: 'Dr. Siti', specialty: 'GP' };
    const pEvent = normalizeReferenceSyncEvent('provider', provider);
    expect(pEvent.entityType).toBe('reference');
    expect(pEvent.entityId).toBe('DOC-01');
    expect(pEvent.eventType).toBe('PROVIDER_SYNCED');
    expect(() => SyncEventSchema.parse(pEvent)).not.toThrow();

    const service = { id: 'SRV-01', name: 'Consultation', durationMinutes: 15 };
    const sEvent = normalizeReferenceSyncEvent('service', service);
    expect(sEvent.entityType).toBe('reference');
    expect(sEvent.entityId).toBe('SRV-01');
    expect(sEvent.eventType).toBe('SERVICE_SYNCED');
    expect(() => SyncEventSchema.parse(sEvent)).not.toThrow();
  });
});
