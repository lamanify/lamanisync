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

  it('returns ERROR when CMS responds with 200/201 but missing appointment ID', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ success: true, message: 'Created' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await executePredefinedAction({
      actionId: ACTION_APPOINTMENT_CREATE,
      correlationId: 'cmd-create-noid',
      parameters: {
        patientId: 'P01',
        providerId: 'DOC01',
        startTime: '2026-09-25T10:00:00+08:00',
        endTime: '2026-09-25T10:30:00+08:00',
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.status).toBe('ERROR');
    expect(result.error?.code).toBe('INVALID_CMS_RESPONSE');
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

  it('delegates write directly to window.supabase client in MAIN world without leaking tokens', async () => {
    const mockInsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'APT-SB-1',
            patient_id: 'P01',
            provider_id: 'DOC01',
            start_time: '2026-10-01T10:00:00+08:00',
            end_time: '2026-10-01T10:15:00+08:00',
            status: 'booked',
            rev: 1,
            created_at: '2026-09-23T00:00:00Z',
          },
          error: null,
        }),
      }),
    });

    const mockSupabase = {
      from: vi.fn((table: string) => {
        expect(table).toBe('appointments');
        return { insert: mockInsert };
      }),
    };

    const result = await executePredefinedAction({
      actionId: ACTION_APPOINTMENT_CREATE,
      correlationId: 'cmd-sb-1',
      parameters: {
        patientId: 'P01',
        providerId: 'DOC01',
        startTime: '2026-10-01T10:00:00+08:00',
        endTime: '2026-10-01T10:15:00+08:00',
      },
      supabaseClient: mockSupabase,
    });

    expect(result.status).toBe('SUCCESS');
    expect(mockSupabase.from).toHaveBeenCalledWith('appointments');
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        patient_id: 'P01',
        provider_id: 'DOC01',
        status: 'booked',
      })
    );
    const data = result.data as ApptResult;
    expect(data.id).toBe('APT-SB-1');
  });

  it('executes PostgREST recipe override with snake_case mapping and Prefer representation header', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('/rest/v1/appointments');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Prefer']).toBe('return=representation');
      const body = JSON.parse(init?.body as string);
      expect(body.patient_id).toBe('P01');
      return new Response(
        JSON.stringify([
          {
            id: 'APT-PGRST-1',
            patient_id: 'P01',
            provider_id: 'DOC01',
            start_time: '2026-10-01T10:00:00+08:00',
            end_time: '2026-10-01T10:15:00+08:00',
            status: 'booked',
            rev: 1,
          },
        ]),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await executePredefinedAction({
      actionId: ACTION_APPOINTMENT_CREATE,
      correlationId: 'cmd-pgrst-1',
      parameters: {
        patientId: 'P01',
        providerId: 'DOC01',
        startTime: '2026-10-01T10:00:00+08:00',
        endTime: '2026-10-01T10:15:00+08:00',
      },
      fetchFn: mockFetch as unknown as typeof fetch,
      recipe: {
        path: '/rest/v1/appointments',
        method: 'POST',
      },
    });

    expect(result.status).toBe('SUCCESS');
    const data = result.data as ApptResult;
    expect(data.id).toBe('APT-PGRST-1');
    expect(data.status).toBe('booked');
  });
});
