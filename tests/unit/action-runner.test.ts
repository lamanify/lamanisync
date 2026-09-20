// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  executePredefinedAction,
  ACTION_APPOINTMENT_CREATE,
  ACTION_APPOINTMENT_RESCHEDULE,
  ACTION_APPOINTMENT_CANCEL,
  ACTION_APPOINTMENT_VERIFY,
  isAllowlistedActionId,
} from '../../src/page/action-runner.js';

interface ApptResult {
  id: string;
  status: string;
  rev?: number;
}

describe('Predefined Action Runner (Phase 5)', () => {
  it('identifies allowlisted actions and rejects arbitrary action IDs', () => {
    expect(isAllowlistedActionId('ACTION_APPOINTMENT_CREATE')).toBe(true);
    expect(isAllowlistedActionId('ACTION_APPOINTMENT_CANCEL')).toBe(true);
    expect(isAllowlistedActionId('ACTION_ARBITRARY_FETCH')).toBe(false);
    expect(isAllowlistedActionId('RUN_RAW_SQL')).toBe(false);
  });

  it('rejects unallowlisted action IDs immediately (AGENTS.md Rule 8)', async () => {
    const mockFetch = vi.fn();
    const result = await executePredefinedAction({
      actionId: 'ACTION_EXEC_COMMAND',
      correlationId: 'cmd-999',
      parameters: { url: 'https://evil.com' },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.status).toBe('ERROR');
    expect(result.error?.code).toBe('UNSUPPORTED_ACTION_ID');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects arbitrary parameter injection attempting to redirect URL or method', async () => {
    const mockFetch = vi.fn();
    const result = await executePredefinedAction({
      actionId: ACTION_APPOINTMENT_CREATE,
      correlationId: 'cmd-1',
      parameters: {
        patientId: 'P01',
        providerId: 'DOC01',
        startTime: '2026-09-25T10:00:00+08:00',
        endTime: '2026-09-25T10:30:00+08:00',
        url: 'http://malicious.com/api', // unauthorized parameter
        method: 'DELETE',
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.status).toBe('ERROR');
    expect(result.error?.code).toBe('INVALID_ACTION_PARAMETERS');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('executes ACTION_APPOINTMENT_CREATE canned recipe using credentials: include', async () => {
    const mockCreatedAppt = {
      id: 'APT-999',
      patientId: 'P01',
      providerId: 'DOC01',
      startTime: '2026-09-25T10:00:00+08:00',
      endTime: '2026-09-25T10:30:00+08:00',
      status: 'booked',
      rev: 1,
      createdAt: '2026-09-21T07:00:00Z',
    };

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/api/appointments');
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('include');
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.patientId).toBe('P01');
      return new Response(JSON.stringify({ data: mockCreatedAppt }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await executePredefinedAction({
      actionId: ACTION_APPOINTMENT_CREATE,
      correlationId: 'cmd-create-1',
      parameters: {
        patientId: 'P01',
        providerId: 'DOC01',
        startTime: '2026-09-25T10:00:00+08:00',
        endTime: '2026-09-25T10:30:00+08:00',
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.status).toBe('SUCCESS');
    const data = result.data as ApptResult;
    expect(data.id).toBe('APT-999');
    expect(data.status).toBe('booked');
  });

  it('executes ACTION_APPOINTMENT_RESCHEDULE and handles 409 CONFLICT', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'CONFLICT',
          message: 'Provider is already booked at this time slot',
          existingAppointmentId: 'APT-002',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await executePredefinedAction({
      actionId: ACTION_APPOINTMENT_RESCHEDULE,
      correlationId: 'cmd-resched-1',
      parameters: {
        appointmentId: 'APT-001',
        startTime: '2026-09-25T14:00:00+08:00',
        expectedRev: 2,
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.status).toBe('CONFLICT');
    expect(result.error?.code).toBe('CONFLICT');
    expect(result.error?.details?.existingAppointmentId).toBe('APT-002');
  });

  it('executes ACTION_APPOINTMENT_CANCEL via canned DELETE recipe', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/api/appointments/APT-001');
      expect(init?.method).toBe('DELETE');
      return new Response(
        JSON.stringify({ data: { id: 'APT-001', status: 'cancelled', rev: 3 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await executePredefinedAction({
      actionId: ACTION_APPOINTMENT_CANCEL,
      correlationId: 'cmd-cancel-1',
      parameters: { appointmentId: 'APT-001' },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.status).toBe('SUCCESS');
    const data = result.data as ApptResult;
    expect(data.status).toBe('cancelled');
  });

  it('executes ACTION_APPOINTMENT_VERIFY read-after-write verification (Rule 10)', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/api/appointments/APT-001');
      expect(init?.method).toBe('GET');
      return new Response(
        JSON.stringify({
          data: {
            id: 'APT-001',
            patientId: 'P01',
            providerId: 'DOC01',
            startTime: '2026-09-25T10:00:00+08:00',
            endTime: '2026-09-25T10:30:00+08:00',
            status: 'booked',
            rev: 2,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await executePredefinedAction({
      actionId: ACTION_APPOINTMENT_VERIFY,
      correlationId: 'cmd-verify-1',
      parameters: { appointmentId: 'APT-001' },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.status).toBe('SUCCESS');
    const data = result.data as ApptResult;
    expect(data.id).toBe('APT-001');
    expect(data.rev).toBe(2);
  });
});
