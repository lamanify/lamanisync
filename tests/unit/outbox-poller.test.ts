import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OutboxPoller } from '../../src/background/outbox-poller.js';
import { SyncApiClient } from '../../src/background/api-client.js';
import { LeaseCoordinator } from '../../src/background/lease-client.js';
import { CommandExecutor } from '../../src/background/command-executor.js';
import { ConnectionFSM } from '../../src/background/connection-fsm.js';
import { type AdapterManifest } from '../../src/adapters/schema.js';

describe('Outbox Command Poller (Phase 8)', () => {
  let apiClient: SyncApiClient;
  let leaseCoordinator: LeaseCoordinator;
  let commandExecutor: CommandExecutor;
  let fsm: ConnectionFSM;
  let poller: OutboxPoller;

  const validManifest: AdapterManifest = {
    adapterId: 'acme-test-v1',
    name: 'ACME Test',
    version: '1.0.0',
    targetOrigin: 'http://localhost:4001',
    capabilities: ['APPOINTMENT_WRITE', 'PATIENT_WRITE'],
    endpoints: {},
  };

  beforeEach(() => {
    apiClient = new SyncApiClient();
    leaseCoordinator = new LeaseCoordinator({ apiClient });
    fsm = new ConnectionFSM({ state: 'ACTIVE' });

    commandExecutor = new CommandExecutor({
      apiClient,
      leaseCoordinator,
      fsm,
    });

    poller = new OutboxPoller({
      apiClient,
      leaseCoordinator,
      commandExecutor,
      fsm,
      connectionId: 'conn_test_1',
      adapterManifest: validManifest,
      pollIntervalMs: 1000,
    });
  });

  afterEach(() => {
    poller.stop();
    vi.restoreAllMocks();
  });

  it('skips polling when no active leader lease is held (Multi-workstation safety)', async () => {
    vi.spyOn(leaseCoordinator, 'getActiveLease').mockReturnValue(null);
    const fetchSpy = vi.spyOn(apiClient, 'fetchNextCommand');

    const result = await poller.pollOnce();
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips polling when kill switches or pause flags are active', async () => {
    vi.spyOn(leaseCoordinator, 'getActiveLease').mockReturnValue({
      connectionId: 'conn_test_1',
      installationId: 'inst_test_1',
      leaseId: 'lease_1',
      fencingToken: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      expiresAtMs: Date.now() + 60000,
      acquiredAt: Date.now(),
    });

    // 1. Global paused
    poller.setKillSwitches({ isGlobalPaused: () => true });
    expect(await poller.pollOnce()).toBeNull();

    // 2. Adapter paused
    poller.setKillSwitches({ isAdapterPaused: () => true });
    expect(await poller.pollOnce()).toBeNull();

    // 3. Connection state paused
    poller.setKillSwitches({});
    fsm.transition('PAUSED', { reason: 'Staff paused sync' });
    expect(await poller.pollOnce()).toBeNull();
  });

  it('fails with TERMINAL_FAILURE if adapter lacks required capability for command', async () => {
    vi.spyOn(leaseCoordinator, 'getActiveLease').mockReturnValue({
      connectionId: 'conn_test_1',
      installationId: 'inst_test_1',
      leaseId: 'lease_1',
      fencingToken: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      expiresAtMs: Date.now() + 60000,
      acquiredAt: Date.now(),
    });

    // Manifest without APPOINTMENT_WRITE
    poller.setAdapterManifest({
      ...validManifest,
      capabilities: ['PATIENT_WRITE'],
    });

    vi.spyOn(apiClient, 'fetchNextCommand').mockResolvedValue({
      commandId: 'CMD-NO-CAP',
      action: 'CREATE_APPOINTMENT',
      parameters: {},
    });

    const reportSpy = vi.spyOn(apiClient, 'reportCommandResult').mockResolvedValue({
      acknowledged: true,
      commandId: 'CMD-NO-CAP',
      status: 'TERMINAL_FAILURE',
    });

    const result = await poller.pollOnce();
    expect(result?.status).toBe('TERMINAL_FAILURE');
    expect(reportSpy).toHaveBeenCalledWith(
      'CMD-NO-CAP',
      expect.objectContaining({ status: 'TERMINAL_FAILURE' })
    );
  });

  it('pulls next command and forwards to CommandExecutor', async () => {
    vi.spyOn(leaseCoordinator, 'getActiveLease').mockReturnValue({
      connectionId: 'conn_test_1',
      installationId: 'inst_test_1',
      leaseId: 'lease_1',
      fencingToken: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      expiresAtMs: Date.now() + 60000,
      acquiredAt: Date.now(),
    });

    vi.spyOn(apiClient, 'fetchNextCommand').mockResolvedValue({
      commandId: 'CMD-OK-1',
      action: 'CREATE_APPOINTMENT',
      parameters: { patientId: 'P01' },
    });

    const execSpy = vi.spyOn(commandExecutor, 'executeCommand').mockResolvedValue({
      status: 'VERIFIED',
      commandId: 'CMD-OK-1',
      writeReceipt: { externalId: 'APT-1', revision: 1, verifiedAt: new Date().toISOString() },
    });

    const result = await poller.pollOnce();
    expect(result?.status).toBe('VERIFIED');
    expect(execSpy).toHaveBeenCalled();
  });
});
