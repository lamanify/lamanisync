import { describe, it, expect } from 'vitest';
import { verifyReadBackRecord, areValuesEquivalent } from '../../src/core/verification.js';

describe('Read-After-Write Verifier (Phase 8)', () => {
  it('correctly compares timestamps across timezones and formatting', () => {
    expect(areValuesEquivalent('2026-10-01T09:00:00Z', '2026-10-01T17:00:00+08:00')).toBe(true);
    expect(areValuesEquivalent('2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00Z')).toBe(true);
    expect(areValuesEquivalent('2026-10-01T09:00:00Z', '2026-10-01T09:30:00Z')).toBe(false);
  });

  it('verifies appointment creation when read-back fields match canonical values', () => {
    const intended = {
      patientId: 'ZZTEST-P01',
      providerId: 'DOC-01',
      startTime: '2026-10-01T09:00:00+08:00',
      endTime: '2026-10-01T09:15:00+08:00',
    };

    const readBack = {
      data: {
        id: 'APT-100',
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T01:00:00Z', // equivalent UTC timestamp
        endTime: '2026-10-01T01:15:00Z',
        status: 'booked',
        rev: 1,
      },
    };

    const result = verifyReadBackRecord('CREATE_APPOINTMENT', intended, readBack);
    expect(result.verified).toBe(true);
    expect(result.writeReceipt).toBeDefined();
    expect(result.writeReceipt?.externalId).toBe('APT-100');
    expect(result.writeReceipt?.revision).toBe(1);
    expect(result.writeReceipt?.verifiedAt).toBeDefined();
  });

  it('fails verification if read-back appointment slot or patientId does not match (AGENTS.md Rule 10)', () => {
    const intended = {
      patientId: 'ZZTEST-P01',
      providerId: 'DOC-01',
      startTime: '2026-10-01T09:00:00+08:00',
    };

    const readBack = {
      id: 'APT-101',
      patientId: 'ZZTEST-P99', // Mismatched patient!
      providerId: 'DOC-01',
      startTime: '2026-10-01T09:00:00+08:00',
      status: 'booked',
    };

    const result = verifyReadBackRecord('CREATE_APPOINTMENT', intended, readBack);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('patientId');
    expect(result.mismatches?.patientId).toBeDefined();
  });

  it('fails verification if read-back status is not booked for appointment creation', () => {
    const intended = {
      patientId: 'ZZTEST-P01',
      providerId: 'DOC-01',
      startTime: '2026-10-01T09:00:00+08:00',
    };

    const readBack = {
      id: 'APT-102',
      patientId: 'ZZTEST-P01',
      providerId: 'DOC-01',
      startTime: '2026-10-01T09:00:00+08:00',
      status: 'cancelled',
    };

    const result = verifyReadBackRecord('CREATE_APPOINTMENT', intended, readBack);
    expect(result.verified).toBe(false);
    expect(result.mismatches?.status).toBeDefined();
  });

  it('verifies appointment reschedule and checks revision increment', () => {
    const intended = {
      appointmentId: 'APT-103',
      startTime: '2026-10-01T15:00:00+08:00',
      endTime: '2026-10-01T15:30:00+08:00',
    };

    const readBack = {
      id: 'APT-103',
      startTime: '2026-10-01T15:00:00+08:00',
      endTime: '2026-10-01T15:30:00+08:00',
      status: 'booked',
      rev: 2,
    };

    const result = verifyReadBackRecord('RESCHEDULE_APPOINTMENT', intended, readBack);
    expect(result.verified).toBe(true);
    expect(result.writeReceipt?.externalId).toBe('APT-103');
    expect(result.writeReceipt?.revision).toBe(2);
  });

  it('verifies appointment cancellation ensuring status is cancelled', () => {
    const intended = {
      appointmentId: 'APT-104',
    };

    const readBack = {
      id: 'APT-104',
      status: 'cancelled',
      rev: 3,
    };

    const result = verifyReadBackRecord('CANCEL_APPOINTMENT', intended, readBack);
    expect(result.verified).toBe(true);
    expect(result.writeReceipt?.revision).toBe(3);

    // If status is not cancelled, fails
    const notCancelled = { ...readBack, status: 'booked' };
    const failResult = verifyReadBackRecord('CANCEL_APPOINTMENT', intended, notCancelled);
    expect(failResult.verified).toBe(false);
  });

  it('verifies patient creation canonical fields', () => {
    const intended = {
      fullName: 'Alice Tan',
      phone: '+60123456789',
    };

    const readBack = {
      id: 'P-999',
      fullName: 'Alice Tan',
      phone: '+60123456789',
    };

    const result = verifyReadBackRecord('CREATE_PATIENT', intended, readBack);
    expect(result.verified).toBe(true);
    expect(result.writeReceipt?.externalId).toBe('P-999');

    // Phone mismatch fails
    const mismatch = verifyReadBackRecord('CREATE_PATIENT', intended, {
      ...readBack,
      phone: '+60123456700',
    });
    expect(mismatch.verified).toBe(false);
  });

  it('handles null, undefined, or malformed read-back records gracefully', () => {
    expect(verifyReadBackRecord('CREATE_APPOINTMENT', {}, null).verified).toBe(false);
    expect(verifyReadBackRecord('CREATE_APPOINTMENT', {}, 'not-an-object').verified).toBe(false);
  });
});
