// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  TargetOriginSchema,
  NormalizedPatientSchema,
  normalizePatient,
  NormalizedAppointmentSchema,
  normalizeAppointment,
  SyncEventSchema,
  SyncCommandSchema,
  WriteReceiptSchema,
  CommandResultSchema,
  CompatibilityReportSchema,
  ConnectionStateRecordSchema,
} from '../../src/core/contracts/index.js';
import { createInitialCmsState } from '../../test-harness/fixtures/synthetic-data.js';

describe('Core Contracts & Runtime Schemas', () => {
  const cmsState = createInitialCmsState();

  describe('NormalizedPatientSchema & normalizePatient', () => {
    it('normalizes synthetic patient fixtures deterministically', () => {
      const raw = cmsState.patients[0];
      const patient = normalizePatient(raw);

      expect(patient.id).toBe('ZZTEST-P01');
      expect(patient.fullName).toBe('ZZTEST Patient 01');
      expect(patient.phone).toBe('+60123456701');
      expect(patient.gender).toBe('female');
      expect(patient.dateOfBirth).toBe('1990-01-01');

      // Validates against strict schema
      expect(() => NormalizedPatientSchema.parse(patient)).not.toThrow();
    });

    it('cleanses raw messy phone inputs and trims whitespace', () => {
      const raw = {
        id: 'P-999',
        fullName: '  Dirty Name  ',
        phone: ' +60 (12) 345-6789 ',
        gender: 'MALE',
      };

      const patient = normalizePatient(raw);
      expect(patient.fullName).toBe('Dirty Name');
      expect(patient.phone).toBe('+60123456789');
      expect(patient.gender).toBe('male');
    });

    it('rejects invalid inputs lacking required fields', () => {
      expect(() => normalizePatient(null)).toThrow();
      expect(() => normalizePatient('not an object')).toThrow();
      expect(() => normalizePatient({ id: 'P-1' })).toThrow(); // missing phone & fullName
    });

    it('strips extraneous unexpected fields to prevent PHI leakage', () => {
      const raw = {
        id: 'P-01',
        fullName: 'Test Patient',
        phone: '+60123456701',
        secretMedicalNotes: 'Classified diagnosis',
        internalBillingCode: '999',
      };

      const patient = normalizePatient(raw);
      expect((patient as Record<string, unknown>).secretMedicalNotes).toBeUndefined();
      expect((patient as Record<string, unknown>).internalBillingCode).toBeUndefined();
    });

    it('extracts dateOfBirth YYYY-MM-DD cleanly from ISO timestamps', () => {
      const raw = {
        id: 'P-02',
        fullName: 'Test Patient 2',
        phone: '+60123456702',
        dateOfBirth: '1985-06-15T00:00:00.000Z',
      };

      const patient = normalizePatient(raw);
      expect(patient.dateOfBirth).toBe('1985-06-15');
    });
  });

  describe('NormalizedAppointmentSchema & normalizeAppointment', () => {
    it('normalizes synthetic appointment fixtures deterministically', () => {
      const raw = cmsState.appointments[0];
      const appt = normalizeAppointment(raw);

      expect(appt.id).toBe('APT-001');
      expect(appt.patientId).toBe('ZZTEST-P01');
      expect(appt.providerId).toBe('DOC-01');
      expect(appt.slotDate).toBe('2026-10-01');
      expect(appt.slotTimeNaive).toBe('09:00:00');
      expect(appt.revision).toBe(1);
      expect(appt.status).toBe('booked');

      expect(() => NormalizedAppointmentSchema.parse(appt)).not.toThrow();
    });

    it('derives slotDate and slotTimeNaive from startTime when omitted', () => {
      const raw = {
        id: 'APT-999',
        patientId: 'P-1',
        providerId: 'DOC-1',
        serviceId: 'SRV-1',
        startTime: '2026-11-15T14:30:00+08:00',
        endTime: '2026-11-15T14:45:00+08:00',
        status: 'booked',
        rev: 3,
      };

      const appt = normalizeAppointment(raw);
      expect(appt.slotDate).toBe('2026-11-15');
      expect(appt.slotTimeNaive).toBe('14:30:00');
      expect(appt.revision).toBe(3);
    });

    it('normalizes SQL space-separated datetime and strips milliseconds from slotTimeNaive', () => {
      const raw = {
        id: 'APT-998',
        patientId: 'P-1',
        providerId: 'DOC-1',
        serviceId: 'SRV-1',
        startTime: '2026-11-15 14:30:00',
        endTime: '2026-11-15 14:45:00',
        slotTimeNaive: '14:30:00.000',
      };

      const appt = normalizeAppointment(raw);
      expect(appt.slotDate).toBe('2026-11-15');
      expect(appt.slotTimeNaive).toBe('14:30:00');
    });

    it('normalizes appointment status variants (e.g. cancelled / canceled)', () => {
      const raw = {
        ...cmsState.appointments[0],
        status: 'canceled',
      };
      const appt = normalizeAppointment(raw);
      expect(appt.status).toBe('cancelled');
    });

    it('rejects malformed dates and invalid slots', () => {
      const bad = {
        ...cmsState.appointments[0],
        slotDate: 'not-a-date',
      };
      expect(() => NormalizedAppointmentSchema.parse(bad)).toThrow();
    });
  });

  describe('TargetOriginSchema', () => {
    it('rejects URLs containing basic auth credentials', () => {
      expect(() => TargetOriginSchema.parse('http://admin:secret@localhost:4001')).toThrow(
        /credentials/
      );
    });

    it('normalizes valid origins by stripping trailing slashes', () => {
      expect(TargetOriginSchema.parse('http://localhost:4001/')).toBe('http://localhost:4001');
    });
  });

  describe('SyncEventSchema', () => {
    it('parses valid sync event payload', () => {
      const event = {
        eventId: 'evt_001',
        entityType: 'appointment',
        entityId: 'APT-001',
        eventType: 'APPOINTMENT_BOOKED',
        revision: 1,
        occurredAt: '2026-09-21T05:40:00Z',
        payload: { patientId: 'ZZTEST-P01', providerId: 'DOC-01' },
      };

      const parsed = SyncEventSchema.parse(event);
      expect(parsed.eventId).toBe('evt_001');
      expect(parsed.revision).toBe(1);
    });

    it('rejects event with negative revision or missing IDs', () => {
      expect(() =>
        SyncEventSchema.parse({
          eventId: 'evt_001',
          entityType: 'appointment',
          entityId: 'APT-001',
          eventType: 'APPOINTMENT_BOOKED',
          revision: -1,
          occurredAt: '2026-09-21T05:40:00Z',
        })
      ).toThrow();
    });
  });

  describe('SyncCommandSchema & WriteReceiptSchema', () => {
    it('maps actionId/payload alias into action/parameters', () => {
      const raw = {
        commandId: 'CMD-001',
        connectionId: 'conn_1',
        actionId: 'CREATE_APPOINTMENT',
        payload: { patientId: 'P1' },
        fencingToken: 2,
      };

      const parsed = SyncCommandSchema.parse(raw);
      expect(parsed.action).toBe('CREATE_APPOINTMENT');
      expect(parsed.parameters).toEqual({ patientId: 'P1' });
      expect(parsed.fencingToken).toBe(2);
    });

    it('validates write receipts with non-negative revision and verifiedAt timestamp', () => {
      const receipt = {
        externalId: 'APT-004',
        revision: 1,
        verifiedAt: '2026-09-21T05:45:00Z',
      };

      const parsed = WriteReceiptSchema.parse(receipt);
      expect(parsed.externalId).toBe('APT-004');
    });

    it('validates command results for all outcome statuses', () => {
      const validStatuses = ['VERIFIED', 'CONFLICT', 'RETRYABLE', 'TERMINAL_FAILURE'] as const;
      for (const status of validStatuses) {
        const res = CommandResultSchema.parse({
          status,
          commandId: 'CMD-1',
        });
        expect(res.status).toBe(status);
      }
    });
  });

  describe('CompatibilityReportSchema', () => {
    it('parses valid compatibility reports', () => {
      const report = {
        installationId: 'inst_mock_12345',
        capabilities: ['PATIENT_READ', 'APPOINTMENT_WRITE'],
        cmsVersion: 'v2.4.1',
        passed: true,
        details: { activeModules: ['booking'] },
      };

      const parsed = CompatibilityReportSchema.parse(report);
      expect(parsed.passed).toBe(true);
      expect(parsed.capabilities).toContain('PATIENT_READ');
    });

    it('strictly rejects reports containing unknown capabilities', () => {
      const report = {
        installationId: 'inst_mock_12345',
        capabilities: ['PATIENT_READ', '__UNKNOWN_DANGEROUS_EVAL__'],
        cmsVersion: 'v2.4.1',
        passed: true,
      };

      expect(() => CompatibilityReportSchema.parse(report)).toThrow();
    });
  });

  describe('ConnectionStateRecordSchema', () => {
    it('enforces required reason and timestamp on state records', () => {
      const record = {
        state: 'ACTIVE',
        reason: 'Host permissions granted and probe passed',
        timestamp: new Date().toISOString(),
        targetOrigin: 'http://localhost:4001',
      };

      const parsed = ConnectionStateRecordSchema.parse(record);
      expect(parsed.state).toBe('ACTIVE');
      expect(parsed.reason).toContain('Host permissions');
    });

    it('rejects records with empty reason', () => {
      expect(() =>
        ConnectionStateRecordSchema.parse({
          state: 'ACTIVE',
          reason: '',
          timestamp: new Date().toISOString(),
        })
      ).toThrow();
    });
  });
});
