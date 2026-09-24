/**
 * Outbox Command Poller (Phase 8)
 * Periodically polls pending outbound sync commands from LamaniHub,
 * validates them against schemas and adapter capabilities, and executes them
 * via CommandExecutor under a strict leader lease.
 * Conforms to AGENTS.md:
 * Rule 4: Never copy or transmit CMS secrets.
 * Rule 7: Ephemeral SW safe; stops on lease loss, resumes on startup.
 * Rule 9: Validate every message and remote command at runtime.
 */

import { SyncApiClient } from './api-client.js';
import { LeaseCoordinator } from './lease-client.js';
import { CommandExecutor } from './command-executor.js';
import { ConnectionFSM } from './connection-fsm.js';
import { type AdapterManifest } from '../adapters/schema.js';
import { type SyncCommand, type CommandResult, SyncCommandSchema } from '../core/contracts/commands.js';
import { LamaniError } from '../core/errors.js';

export const OUTBOX_ALARM_NAME = 'lamanisync_outbox_poll';

export interface KillSwitchOptions {
  isGlobalPaused?: () => boolean;
  isAdapterPaused?: (adapterId?: string) => boolean;
  isConnectionPaused?: (connectionId?: string) => boolean;
}

export interface OutboxPollerOptions {
  apiClient: SyncApiClient;
  leaseCoordinator: LeaseCoordinator;
  commandExecutor: CommandExecutor;
  fsm: ConnectionFSM;
  connectionId: string;
  pollIntervalMs?: number;
  adapterManifest?: AdapterManifest;
  killSwitches?: KillSwitchOptions;
  onCommandSettled?: (result: CommandResult) => Promise<void> | void;
}

export class OutboxPoller {
  private apiClient: SyncApiClient;
  private leaseCoordinator: LeaseCoordinator;
  private commandExecutor: CommandExecutor;
  private fsm: ConnectionFSM;
  private connectionId: string;
  private pollIntervalMs: number;
  private adapterManifest?: AdapterManifest;
  private killSwitches?: KillSwitchOptions;
  private onCommandSettled?: (result: CommandResult) => Promise<void> | void;

  private isRunning: boolean = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private isCurrentlyPolling: boolean = false;

  constructor(options: OutboxPollerOptions) {
    this.apiClient = options.apiClient;
    this.leaseCoordinator = options.leaseCoordinator;
    this.commandExecutor = options.commandExecutor;
    this.fsm = options.fsm;
    this.connectionId = options.connectionId;
    this.pollIntervalMs = options.pollIntervalMs || 2000;
    this.adapterManifest = options.adapterManifest;
    this.killSwitches = options.killSwitches;
    this.onCommandSettled = options.onCommandSettled;
  }

  setConnectionId(connectionId: string): void {
    this.connectionId = connectionId;
  }

  setAdapterManifest(manifest?: AdapterManifest): void {
    this.adapterManifest = manifest;
    this.commandExecutor.setAdapterManifest(manifest);
  }

  setKillSwitches(killSwitches?: KillSwitchOptions): void {
    this.killSwitches = killSwitches;
  }

  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Starts periodic polling loop.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Schedule next poll
    this.scheduleNextPoll(100); // Poll immediately on start
  }

  /**
   * Stops polling loop.
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNextPoll(delayMs?: number): void {
    if (!this.isRunning) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);

    const delay = delayMs ?? this.pollIntervalMs;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (this.isRunning) {
        await this.pollOnce().catch(() => {});
        this.scheduleNextPoll();
      }
    }, delay);
  }

  /**
   * Evaluates if any remote kill switch or pause flag is active.
   */
  isPaused(): boolean {
    if (this.killSwitches?.isGlobalPaused?.()) return true;
    if (this.killSwitches?.isAdapterPaused?.(this.adapterManifest?.adapterId)) return true;
    if (this.killSwitches?.isConnectionPaused?.(this.connectionId)) return true;
    if (this.fsm.getState() === 'PAUSED') return true;
    return false;
  }

  /**
   * Checks whether the given command action is supported by the adapter's capabilities.
   */
  assertCapabilityForAction(command: SyncCommand): void {
    if (!this.adapterManifest) return;

    const norm = command.action.toUpperCase().replace(/^ACTION_/, '').replace(/-/g, '_');
    const capabilities = this.adapterManifest.capabilities;

    if (norm.includes('APPOINTMENT') && !capabilities.includes('APPOINTMENT_WRITE')) {
      throw new LamaniError(
        `Adapter '${this.adapterManifest.adapterId}' lacks required capability 'APPOINTMENT_WRITE' for action '${command.action}'`,
        'MISSING_CAPABILITY'
      );
    }

    if (norm.includes('PATIENT') && !capabilities.includes('PATIENT_WRITE')) {
      throw new LamaniError(
        `Adapter '${this.adapterManifest.adapterId}' lacks required capability 'PATIENT_WRITE' for action '${command.action}'`,
        'MISSING_CAPABILITY'
      );
    }
  }

  /**
   * Performs a single fenced pull-and-execute cycle.
   */
  async pollOnce(): Promise<CommandResult | null> {
    if (this.isCurrentlyPolling) return null;

    // 1. Multi-workstation Safety: Verify active leader lease with fencing token
    let lease = this.leaseCoordinator.getActiveLease();
    if (!lease || lease.fencingToken <= 0) {
      if (this.connectionId && this.fsm.getState() === 'ACTIVE') {
        const renewed = await this.leaseCoordinator.renew().catch(() => false);
        if (renewed) {
          lease = this.leaseCoordinator.getActiveLease();
        }
      }
      if (!lease || lease.fencingToken <= 0) {
        return null;
      }
    }

    // 2. Respect kill switches & connection readiness
    if (this.isPaused()) {
      this.stop();
      return null;
    }

    if (this.fsm.getState() !== 'ACTIVE') {
      return null;
    }

    this.isCurrentlyPolling = true;

    try {
      // 3. Pull next command from outbox
      let rawCommand: SyncCommand | null = null;
      try {
        rawCommand = await this.apiClient.fetchNextCommand(this.connectionId);
      } catch (fetchErr) {
        const errStatusCode = (fetchErr as { statusCode?: number }).statusCode;
        const errMsg = (fetchErr as Error).message || '';
        if (errStatusCode === 403 || errMsg.includes('PAUSED') || (fetchErr as { code?: string }).code === 'SERVICE_PAUSED') {
          this.stop();
          if (this.fsm.canTransition('PAUSED')) {
            this.fsm.transition('PAUSED', {
              reason: `Outbox polling halted due to remote kill-switch: ${errMsg}`,
            });
          }
          return null;
        }
        throw fetchErr;
      }

      if (!rawCommand) {
        return null;
      }

      // 4. Validate command schema
      const command = SyncCommandSchema.parse(rawCommand);

      // 5. Validate adapter capability matrix
      try {
        this.assertCapabilityForAction(command);
      } catch (capErr) {
        const failResult: CommandResult = {
          status: 'TERMINAL_FAILURE',
          commandId: command.commandId,
          error: { message: (capErr as Error).message },
          acknowledged: false,
          occurredAt: new Date().toISOString(),
        };
        await this.apiClient.reportCommandResult(command.commandId, failResult);
        return failResult;
      }

      // 6. Execute safe 10-step command lifecycle
      const result = await this.commandExecutor.executeCommand(command);
      if (this.onCommandSettled) {
        try {
          await this.onCommandSettled(result);
        } catch {
          // ignore callback error
        }
      }
      return result;
    } finally {
      this.isCurrentlyPolling = false;
    }
  }
}
