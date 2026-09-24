// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProbeRunner } from '../../src/background/probe.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { SyncApiClient } from '../../src/background/api-client.js';

describe('Probe & Compatibility Checker (Phase 7)', () => {
  let fsm: ConnectionFSM;
  let apiClient: SyncApiClient;

  beforeEach(() => {
    fsm = new ConnectionFSM({ state: 'PROBING' });
    apiClient = new SyncApiClient();
    vi.spyOn(apiClient, 'reportProbeResult').mockResolvedValue({
      status: 'ok',
      connectionId: 'conn_1',
      recordedAt: new Date().toISOString(),
    });
  });

  it('runs successful probe and transitions FSM from PROBING to ACTIVE', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/auth/session')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            clinicId: 'CLN-001',
            staff: { id: 'STF-01', role: 'receptionist' },
          }),
        } as Response;
      }
      if (url.includes('/api/reference/providers')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'DOC-01' }] }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const runner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      expectedClinicId: 'CLN-001',
      fetchFn: mockFetch,
    });

    const result = await runner.runProbe();

    expect(result.passed).toBe(true);
    expect(result.capabilities).toContain('PATIENT_READ');
    expect(result.capabilities).toContain('REFERENCE_DATA_READ');
    expect(fsm.getState()).toBe('ACTIVE');
    expect(apiClient.reportProbeResult).toHaveBeenCalledWith('conn_1', expect.objectContaining({
      passed: true,
      installationId: 'inst_1',
    }));
  });

  it('transitions FSM to REAUTH_REQUIRED when CMS responds with 401 Unauthorized', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'UNAUTHORIZED' }),
      headers: new Headers(),
    } as Response);

    const runner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      fetchFn: mockFetch,
    });

    const result = await runner.runProbe();

    expect(result.passed).toBe(false);
    expect(fsm.getState()).toBe('REAUTH_REQUIRED');
  });

  it('transitions FSM to DEGRADED when CMS responds with 403 Forbidden', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'FORBIDDEN' }),
      headers: new Headers(),
    } as Response);

    const runner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      fetchFn: mockFetch,
    });

    const result = await runner.runProbe();

    expect(result.passed).toBe(false);
    expect(fsm.getState()).toBe('DEGRADED');
  });

  it('fails probe on tenant mismatch without transitioning to ACTIVE', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        authenticated: true,
        clinicId: 'CLN-OTHER', // Different clinic
      }),
      headers: new Headers(),
    } as Response);

    const runner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: 'http://localhost:4001',
      connectionId: 'conn_1',
      installationId: 'inst_1',
      expectedClinicId: 'CLN-001',
      fetchFn: mockFetch,
    });

    const result = await runner.runProbe();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Tenant mismatch');
    expect(fsm.getState()).toBe('PROBING'); // Not transitioned to ACTIVE
  });

  it('runs successful probe for LamaniPulse targetOrigin using PostgREST endpoints', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/rest/v1/profiles')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'USR-01', role: 'doctor' }],
        } as Response;
      }
      if (url.includes('/rest/v1/medical_services')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'SRV-01', name: 'General Consultation' }],
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const runner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: 'https://app.lamanipulse.com',
      connectionId: 'conn_pulse',
      installationId: 'inst_pulse',
      expectedClinicId: 'CLN-PULSE',
      fetchFn: mockFetch,
    });

    const result = await runner.runProbe();

    expect(result.passed).toBe(true);
    expect(fsm.getState()).toBe('ACTIVE');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://app.lamanipulse.com/rest/v1/profiles?select=id&limit=1',
      expect.any(Object)
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://app.lamanipulse.com/rest/v1/medical_services?select=id&limit=1',
      expect.any(Object)
    );
  });

  it('transitions FSM to DEGRADED when CMS network call fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const runner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: 'https://app.lamanipulse.com',
      connectionId: 'conn_pulse',
      installationId: 'inst_pulse',
      fetchFn: mockFetch,
    });

    const result = await runner.runProbe();

    expect(result.passed).toBe(false);
    expect(result.error).toBe('CMS unreachable');
    expect(fsm.getState()).toBe('DEGRADED');
  });

  it('transitions FSM to DEGRADED when CMS responds with 500 error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Server Error' }),
    } as Response);

    const runner = new ProbeRunner({
      fsm,
      apiClient,
      targetOrigin: 'https://app.lamanipulse.com',
      connectionId: 'conn_pulse',
      installationId: 'inst_pulse',
      fetchFn: mockFetch,
    });

    const result = await runner.runProbe();

    expect(result.passed).toBe(false);
    expect(fsm.getState()).toBe('DEGRADED');
  });
});
