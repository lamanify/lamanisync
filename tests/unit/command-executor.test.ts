import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandExecutor, type StorageAdapter } from '../../src/background/command-executor.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { LeaseCoordinator } from '../../src/background/lease-client.js';
import { EchoSuppressor } from '../../src/background/echo-suppressor.js';
import {
  ACTION_APPOINTMENT_CREATE,
} from '../../src/page/action-runner.js';

class MockStorage implements StorageAdapter {
  private store = new Map<string, unknown>();
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const list = Array.isArray(keys) ? keys : [keys];
    const res: Record<string, unknown> = {};
    for (const k of list) {
      if (this.store.has(k)) res[k] = this.store.get(k);
    }
    return res;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.store.set(k, v);
  }
  async remove(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.store.delete(k);
  }
}

describe('Command Execution Coordinator (Phase 8)', () => {
  let storage: MockStorage;
  let fsm: ConnectionFSM;
  let apiClient: SyncApiClient;
  let leaseCoordinator: LeaseCoordinator;
  let echoSuppressor: EchoSuppressor;
  let executor: CommandExecutor;
  let reportedResults: Array<{ commandId: string; status: string; writeReceipt?: unknown; error?: unknown }>;

  beforeEach(() => {
    storage = new MockStorage();
    reportedResults = [];

    fsm = new ConnectionFSM({ state: 'ACTIVE' });
    apiClient = new SyncApiClient();

    // Mock API client result reporting
    apiClient.reportCommandResult = vi.fn(async (commandId, result) => {
      reportedResults.push({ commandId, ...result });
      return { acknowledged: true, commandId, status: result.status };
    });

    leaseCoordinator = new LeaseCoordinator({ apiClient, storage });
    // Mock active lease with fencing token
    vi.spyOn(leaseCoordinator, 'getActiveLease').mockReturnValue({
      connectionId: 'conn_test_1',
      installationId: 'inst_test_1',
      leaseId: 'lease_1',
      fencingToken: 10,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      expiresAtMs: Date.now() + 60000,
      acquiredAt: Date.now(),
    });

    echoSuppressor = new EchoSuppressor({ storage });

    executor = new CommandExecutor({
      apiClient,
      leaseCoordinator,
      fsm,
      echoSuppressor,
      storage,
      targetOrigin: 'http://localhost:4001',
    });
  });

  it('fails closed when connection is not ACTIVE', async () => {
    fsm.transition('DEGRADED', { reason: 'CMS degraded' });

    const cmd = {
      commandId: 'CMD-001',
      action: 'CREATE_APPOINTMENT',
      parameters: { patientId: 'P01', providerId: 'D01', startTime: '2026-10-01T10:00:00Z', endTime: '2026-10-01T10:15:00Z' },
    };

    await expect(executor.executeCommand(cmd)).rejects.toThrow(/Connection not ready for writes/);
  });

  it('fails closed when leader lease is missing or expired', async () => {
    vi.spyOn(leaseCoordinator, 'getActiveLease').mockReturnValue(null);

    const cmd = {
      commandId: 'CMD-001',
      action: 'CREATE_APPOINTMENT',
      parameters: { patientId: 'P01', providerId: 'D01', startTime: '2026-10-01T10:00:00Z', endTime: '2026-10-01T10:15:00Z' },
    };

    await expect(executor.executeCommand(cmd)).rejects.toThrow();
  });

  it('fails closed when action is not allowlisted (AGENTS.md Rule 8)', async () => {
    const cmd = {
      commandId: 'CMD-002',
      action: '__DANGEROUS_CUSTOM_SQL_QUERY__',
      parameters: {},
    };

    const res = await executor.executeCommand(cmd);
    expect(res.status).toBe('TERMINAL_FAILURE');
    expect(reportedResults[0].status).toBe('TERMINAL_FAILURE');
  });

  it('executes full 10-step create appointment lifecycle successfully', async () => {
    // 1. Mock fetch for pre-flight availability check and independent read-back
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/appointments/availability')) {
        return new Response(JSON.stringify({ slots: [{ startTime: '2026-10-01T10:00:00+08:00', available: true }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('/api/appointments?providerId=')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/api/appointments/APT-CREATED-999')) {
        // Independent read-back
        return new Response(
          JSON.stringify({
            data: {
              id: 'APT-CREATED-999',
              patientId: 'ZZTEST-P01',
              providerId: 'DOC-01',
              startTime: '2026-10-01T10:00:00+08:00',
              endTime: '2026-10-01T10:15:00+08:00',
              status: 'booked',
              rev: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    });

    executor.setFetchFn(mockFetch as unknown as typeof fetch);

    // 2. Mock action dispatcher (simulating content script / MAIN runner)
    executor.setActionDispatcher(async (actionId, _correlationId, params) => {
      expect(actionId).toBe(ACTION_APPOINTMENT_CREATE);
      expect(params.patientId).toBe('ZZTEST-P01');
      return {
        status: 'SUCCESS',
        data: {
          id: 'APT-CREATED-999',
          rev: 1,
        },
      };
    });

    const cmd = {
      commandId: 'CMD-003',
      action: 'CREATE_APPOINTMENT',
      parameters: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T10:00:00+08:00',
        endTime: '2026-10-01T10:15:00+08:00',
      },
    };

    const result = await executor.executeCommand(cmd);
    expect(result.status).toBe('VERIFIED');
    expect(result.writeReceipt?.externalId).toBe('APT-CREATED-999');
    expect(result.writeReceipt?.revision).toBe(1);

    // Check report dispatch
    expect(reportedResults).toHaveLength(1);
    expect(reportedResults[0].status).toBe('VERIFIED');

    // Check echo suppressor registered mutation
    expect(
      echoSuppressor.shouldSuppressObservation({
        entityType: 'appointment',
        entityId: 'APT-CREATED-999',
        revision: 1,
      })
    ).toBe(true);

    // Check transient in-flight state is cleared
    const inFlight = await executor.getInFlightCommand();
    expect(inFlight).toBeNull();
  });

  it('rejects with CONFLICT if independent read-back fails verification (AGENTS.md Rule 10)', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/appointments/APT-MISMATCH-1')) {
        // Read-back entity has mismatched patientId!
        return new Response(
          JSON.stringify({
            data: {
              id: 'APT-MISMATCH-1',
              patientId: 'ZZTEST-P_DIFFERENT', // mismatch!
              providerId: 'DOC-01',
              startTime: '2026-10-01T10:00:00+08:00',
              status: 'booked',
              rev: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ slots: [] }), { status: 200 });
    });

    executor.setFetchFn(mockFetch as unknown as typeof fetch);

    executor.setActionDispatcher(async () => {
      return {
        status: 'SUCCESS',
        data: { id: 'APT-MISMATCH-1', rev: 1 },
      };
    });

    const cmd = {
      commandId: 'CMD-004',
      action: 'CREATE_APPOINTMENT',
      parameters: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T10:00:00+08:00',
        endTime: '2026-10-01T10:15:00+08:00',
      },
    };

    const result = await executor.executeCommand(cmd);
    expect(result.status).toBe('CONFLICT');
    expect(reportedResults[0].status).toBe('CONFLICT');
  });

  it('recovers existing appointment via search-before-retry without duplicate write', async () => {
    let actionExecutionCount = 0;

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/appointments?providerId=DOC-01')) {
        // Pre-flight search finds that appointment was already created previously
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'APT-EXISTING-555',
                patientId: 'ZZTEST-P01',
                providerId: 'DOC-01',
                startTime: '2026-10-01T14:00:00+08:00',
                endTime: '2026-10-01T14:15:00+08:00',
                status: 'booked',
                rev: 1,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.includes('/api/appointments/APT-EXISTING-555')) {
        // Read-back
        return new Response(
          JSON.stringify({
            data: {
              id: 'APT-EXISTING-555',
              patientId: 'ZZTEST-P01',
              providerId: 'DOC-01',
              startTime: '2026-10-01T14:00:00+08:00',
              endTime: '2026-10-01T14:15:00+08:00',
              status: 'booked',
              rev: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    executor.setFetchFn(mockFetch as unknown as typeof fetch);

    executor.setActionDispatcher(async () => {
      actionExecutionCount += 1;
      return { status: 'SUCCESS', data: { id: 'APT-SHOULD-NOT-BE-CALLED' } };
    });

    const cmd = {
      commandId: 'CMD-005',
      action: 'CREATE_APPOINTMENT',
      parameters: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T14:00:00+08:00',
        endTime: '2026-10-01T14:15:00+08:00',
      },
    };

    const result = await executor.executeCommand(cmd);
    expect(result.status).toBe('VERIFIED');
    expect(result.writeReceipt?.externalId).toBe('APT-EXISTING-555');
    // Action was not re-executed! Zero duplicate booking
    expect(actionExecutionCount).toBe(0);
  });

  it('executes command successfully when command already bears matching active lease fencingToken', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/appointments/availability')) {
        return new Response(JSON.stringify({ slots: [{ startTime: '2026-10-01T15:00:00+08:00', available: true }] }), { status: 200 });
      }
      if (urlStr.includes('/api/appointments?providerId=')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes('/api/appointments/APT-TOKEN-10')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'APT-TOKEN-10',
              patientId: 'ZZTEST-P01',
              providerId: 'DOC-01',
              startTime: '2026-10-01T15:00:00+08:00',
              status: 'booked',
              rev: 1,
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    executor.setFetchFn(mockFetch as unknown as typeof fetch);
    executor.setActionDispatcher(async () => {
      return { status: 'SUCCESS', data: { id: 'APT-TOKEN-10', rev: 1 } };
    });

    // Active lease fencingToken is 10 (from beforeEach)
    const cmd = {
      commandId: 'CMD-TOKEN-10',
      action: 'CREATE_APPOINTMENT',
      fencingToken: 10, // already tagged with current lease token
      status: 'LEASED' as const,
      parameters: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T15:00:00+08:00',
        endTime: '2026-10-01T15:15:00+08:00',
      },
    };

    const result = await executor.executeCommand(cmd);
    expect(result.status).toBe('VERIFIED');
    expect(result.writeReceipt?.externalId).toBe('APT-TOKEN-10');
  });

  it('rejects command execution when command carries higher fencingToken than client lease', async () => {
    const cmd = {
      commandId: 'CMD-STALE-TOKEN',
      action: 'CREATE_APPOINTMENT',
      fencingToken: 99, // newer lease exists elsewhere
      parameters: {
        patientId: 'ZZTEST-P01',
        providerId: 'DOC-01',
        startTime: '2026-10-01T16:00:00+08:00',
      },
    };

    await expect(executor.executeCommand(cmd)).rejects.toThrow();
  });

  it('expires stale in-flight command snapshot older than 5 minutes', async () => {
    // Manually store an old in-flight command snapshot
    await storage.set({
      lamanisync_in_flight_command: {
        commandId: 'CMD-OLD',
        action: 'CREATE_APPOINTMENT',
        state: 'EXECUTING',
        fencingToken: 10,
        retryCount: 0,
        lastUpdatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
      },
    });

    const inFlight = await executor.getInFlightCommand();
    expect(inFlight).toBeNull();

    // Storage should be cleared
    const stored = await storage.get('lamanisync_in_flight_command');
    expect(stored.lamanisync_in_flight_command).toBeUndefined();
  });
});
