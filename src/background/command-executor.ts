/**
 * Command Execution Coordinator (Phase 8)
 * Implements the 10-Step Safe Command Execution Lifecycle driven by CommandFSM.
 * Strictly adheres to AGENTS.md:
 * Rule 4: Never copy or transmit CMS secrets.
 * Rule 7: Ephemeral SW safe; in-flight command state is tracked and recoverable.
 * Rule 8: Page-world code may execute only predefined adapter action IDs.
 * Rule 10: An appointment is not confirmed until the CMS write is read back and verified.
 */

import { ConnectionFSM } from './connection-fsm.js';
import { SyncApiClient } from './api-client.js';
import { LeaseCoordinator } from './lease-client.js';
import { EchoSuppressor } from './echo-suppressor.js';
import { IdempotencyResolver } from './idempotency.js';
import { ResultReporter } from './result-reporter.js';
import { CommandFSM } from '../core/command-fsm.js';
import {
  type SyncCommand,
  type CommandResult,
  type WriteReceipt,
  SyncCommandSchema,
} from '../core/contracts/commands.js';
import { type AdapterManifest } from '../adapters/schema.js';
import { verifyReadBackRecord } from '../core/verification.js';
import {
  ACTION_APPOINTMENT_CREATE,
  ACTION_APPOINTMENT_RESCHEDULE,
  ACTION_APPOINTMENT_CANCEL,
  ACTION_APPOINTMENT_VERIFY,
  ACTION_PATIENT_CREATE,
  ACTION_PATIENT_VERIFY,
  type PredefinedActionId,
  isAllowlistedActionId,
  executePredefinedAction,
} from '../page/action-runner.js';
import { FencingTokenError, LamaniError } from '../core/errors.js';

export const IN_FLIGHT_COMMAND_KEY = 'lamanisync_in_flight_command';

export interface StorageAdapter {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function resolveStorage(custom?: StorageAdapter): StorageAdapter {
  if (custom) return custom;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return {
      get: (keys) => chrome.storage.local.get(keys),
      set: (items) => chrome.storage.local.set(items),
      remove: (keys) => chrome.storage.local.remove(keys),
    };
  }
  const mem = new Map<string, unknown>();
  return {
    get: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const res: Record<string, unknown> = {};
      for (const k of list) {
        if (mem.has(k)) res[k] = mem.get(k);
      }
      return res;
    },
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) mem.set(k, v);
    },
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) mem.delete(k);
    },
  };
}

export type ActionDispatcherFn = (
  actionId: PredefinedActionId,
  correlationId: string,
  parameters: Record<string, unknown>
) => Promise<{ status: string; data?: unknown; error?: unknown }>;

export interface CommandExecutorOptions {
  apiClient: SyncApiClient;
  leaseCoordinator: LeaseCoordinator;
  fsm: ConnectionFSM;
  echoSuppressor?: EchoSuppressor;
  idempotencyResolver?: IdempotencyResolver;
  resultReporter?: ResultReporter;
  targetOrigin?: string;
  fetchFn?: typeof fetch;
  actionDispatcher?: ActionDispatcherFn;
  storage?: StorageAdapter;
  maxRetries?: number;
  adapterManifest?: AdapterManifest;
  killSwitches?: {
    isPaused?: () => boolean;
  };
}

export class CommandExecutor {
  private apiClient: SyncApiClient;
  private leaseCoordinator: LeaseCoordinator;
  private fsm: ConnectionFSM;
  private echoSuppressor: EchoSuppressor;
  private idempotencyResolver: IdempotencyResolver;
  private resultReporter: ResultReporter;
  private targetOrigin: string;
  private fetchFn: typeof fetch;
  private actionDispatcher?: ActionDispatcherFn;
  private storage: StorageAdapter;
  private maxRetries: number;
  private adapterManifest?: AdapterManifest;
  private killSwitches?: { isPaused?: () => boolean };

  constructor(options: CommandExecutorOptions) {
    this.apiClient = options.apiClient;
    this.leaseCoordinator = options.leaseCoordinator;
    this.fsm = options.fsm;
    this.targetOrigin = (options.targetOrigin || 'http://localhost:4001').replace(/\/$/, '');
    this.fetchFn = options.fetchFn || ((...args) => globalThis.fetch(...args));
    this.storage = resolveStorage(options.storage);
    this.maxRetries = options.maxRetries ?? 3;
    this.adapterManifest = options.adapterManifest;
    this.killSwitches = options.killSwitches;

    this.echoSuppressor = options.echoSuppressor || new EchoSuppressor({ storage: this.storage });
    this.idempotencyResolver =
      options.idempotencyResolver ||
      new IdempotencyResolver({
        fetchFn: this.fetchFn,
        targetOrigin: this.targetOrigin,
      });
    this.resultReporter = options.resultReporter || new ResultReporter({ apiClient: this.apiClient });
    this.actionDispatcher = options.actionDispatcher;
  }

  setTargetOrigin(origin: string): void {
    this.targetOrigin = origin.replace(/\/$/, '');
    this.idempotencyResolver.setTargetOrigin(this.targetOrigin);
  }

  setFetchFn(fn: typeof fetch): void {
    this.fetchFn = fn;
    this.idempotencyResolver.setFetchFn(fn);
  }

  setActionDispatcher(dispatcher: ActionDispatcherFn): void {
    this.actionDispatcher = dispatcher;
  }

  setAdapterManifest(manifest?: AdapterManifest): void {
    this.adapterManifest = manifest;
  }

  getEchoSuppressor(): EchoSuppressor {
    return this.echoSuppressor;
  }

  getIdempotencyResolver(): IdempotencyResolver {
    return this.idempotencyResolver;
  }

  /**
   * Maps a sync command action name to an allowlisted PredefinedActionId.
   */
  mapActionToPredefinedId(action: string): PredefinedActionId | null {
    const norm = action.toUpperCase().replace(/^ACTION_/, '').replace(/-/g, '_');
    if (norm === 'CREATE_APPOINTMENT' || norm === 'APPOINTMENT_CREATE') {
      return ACTION_APPOINTMENT_CREATE;
    }
    if (norm === 'RESCHEDULE_APPOINTMENT' || norm === 'APPOINTMENT_RESCHEDULE') {
      return ACTION_APPOINTMENT_RESCHEDULE;
    }
    if (norm === 'CANCEL_APPOINTMENT' || norm === 'APPOINTMENT_CANCEL') {
      return ACTION_APPOINTMENT_CANCEL;
    }
    if (norm === 'CREATE_PATIENT' || norm === 'PATIENT_CREATE') {
      return ACTION_PATIENT_CREATE;
    }
    if (isAllowlistedActionId(action)) {
      return action;
    }
    return null;
  }

  /**
   * Dispatches the predefined action either via the custom dispatcher,
   * or directly using executePredefinedAction with ambient credentials.
   */
  private async dispatchAction(
    actionId: PredefinedActionId,
    correlationId: string,
    parameters: Record<string, unknown>
  ): Promise<{ status: string; data?: unknown; error?: unknown }> {
    if (this.actionDispatcher) {
      return this.actionDispatcher(actionId, correlationId, parameters);
    }

    // Default fallback: direct runner execution using fetchFn
    const res = await executePredefinedAction({
      actionId,
      correlationId,
      parameters,
      baseOrigin: this.targetOrigin,
      fetchFn: this.fetchFn,
    });

    return {
      status: res.status,
      data: res.data,
      error: res.error,
    };
  }

  /**
   * Executes the 10-step safe command execution lifecycle.
   */
  async executeCommand(rawCommand: SyncCommand | unknown): Promise<CommandResult> {
    const command = SyncCommandSchema.parse(rawCommand);

    // --- Step 1: Verify fencing token and connection readiness ---
    if (this.killSwitches?.isPaused?.() || this.fsm.getState() === 'PAUSED') {
      throw new LamaniError('Execution paused by kill switch or connection state', 'PAUSED');
    }

    const activeLease = this.leaseCoordinator.getActiveLease();
    if (!activeLease || activeLease.fencingToken <= 0) {
      throw new FencingTokenError(0, 0);
    }

    const connectionState = this.fsm.getState();
    if (connectionState !== 'ACTIVE') {
      throw new LamaniError(
        `Connection not ready for writes: current state is '${connectionState}' (expected 'ACTIVE')`,
        'CONNECTION_NOT_ACTIVE'
      );
    }

    // --- Step 2: Initialize CommandFSM and Lease Command ---
    const commandAlreadyLeased =
      (command.status === 'LEASED' || command.fencingToken === activeLease.fencingToken) &&
      (command.fencingToken === undefined || command.fencingToken === activeLease.fencingToken);

    const fsm = new CommandFSM(command, {
      initialState: commandAlreadyLeased ? 'LEASED' : 'PENDING',
      fencingToken: commandAlreadyLeased ? activeLease.fencingToken : (command.fencingToken ?? 0),
      maxRetries: this.maxRetries,
    });

    if (!commandAlreadyLeased) {
      fsm.lease(activeLease.fencingToken);
    }
    await this.saveInFlightCommand(fsm);

    const actionId = this.mapActionToPredefinedId(command.action);
    if (!actionId) {
      const failResult = fsm.markTerminalFailure(
        `Unsupported action '${command.action}'. Only allowlisted actions are permitted (AGENTS.md Rule 8).`
      );
      await this.resultReporter.report(command.commandId, failResult);
      await this.clearInFlightCommand(command.commandId);
      return failResult;
    }

    // --- Step 3: Pre-flight Check & Search-Before-Write Idempotency ---
    let writeAlreadySucceeded = false;
    let existingRecord: Record<string, unknown> | undefined;

    if (actionId === ACTION_APPOINTMENT_CREATE) {
      const patientId = command.parameters.patientId as string | undefined;
      const providerId = command.parameters.providerId as string | undefined;
      const startTime = command.parameters.startTime as string | undefined;

      if (providerId && startTime) {
        // Idempotency: Search before writing to avoid double creation on retries
        const found = await this.idempotencyResolver.searchExistingAppointment({
          patientId,
          providerId,
          startTime,
        });

        if (found) {
          writeAlreadySucceeded = true;
          existingRecord = found;
        } else {
          // Pre-flight check: Slot availability
          const slotCheck = await this.idempotencyResolver.checkSlotAvailability(providerId, startTime);
          if (!slotCheck.available) {
            const conflictResult = fsm.markConflict(
              slotCheck.reason || `Slot at ${startTime} is already reserved`
            );
            await this.resultReporter.report(command.commandId, conflictResult);
            await this.clearInFlightCommand(command.commandId);
            return conflictResult;
          }
        }
      }
    } else if (actionId === ACTION_APPOINTMENT_RESCHEDULE) {
      const appointmentId = (command.parameters.appointmentId || command.parameters.id) as string | undefined;
      if (appointmentId) {
        const found = await this.idempotencyResolver.searchExistingAppointment({ appointmentId });
        if (found) {
          const expectedRev = command.parameters.expectedRev as number | undefined;
          const currentRev = typeof found.rev === 'number' ? found.rev : 1;
          if (expectedRev !== undefined && currentRev !== expectedRev) {
            // Check if it already has target startTime (idempotent duplicate)
            const targetStartTime = command.parameters.startTime as string | undefined;
            if (targetStartTime && found.startTime === targetStartTime) {
              writeAlreadySucceeded = true;
              existingRecord = found;
            } else {
              const conflictResult = fsm.markConflict(
                `Revision mismatch. Current revision is ${currentRev}, expected ${expectedRev}`
              );
              await this.resultReporter.report(command.commandId, conflictResult);
              await this.clearInFlightCommand(command.commandId);
              return conflictResult;
            }
          }
        }
      }
    } else if (actionId === ACTION_APPOINTMENT_CANCEL) {
      const appointmentId = (command.parameters.appointmentId || command.parameters.id) as string | undefined;
      if (appointmentId) {
        const found = await this.idempotencyResolver.searchExistingAppointment({ appointmentId });
        if (found && found.status === 'cancelled') {
          writeAlreadySucceeded = true;
          existingRecord = found;
        }
      }
    } else if (actionId === ACTION_PATIENT_CREATE) {
      const found = await this.idempotencyResolver.searchExistingPatient({
        fullName: command.parameters.fullName as string | undefined,
        phone: command.parameters.phone as string | undefined,
      });
      if (found) {
        writeAlreadySucceeded = true;
        existingRecord = found;
      }
    }

    // --- Step 4 & 5: Dispatch and Execute Action ---
    let rawReceiptId: string | undefined;
    let rawReceiptRev: number = 1;
    let resolvedPatientId: string | undefined;
    let resolvedProviderId: string | undefined;

    if (!writeAlreadySucceeded) {
      fsm.startExecuting();
      await this.saveInFlightCommand(fsm);

      const correlationId = `cmd-${command.commandId}-${Date.now()}`;
      let actionResult: { status: string; data?: unknown; error?: unknown };

      try {
        actionResult = await this.dispatchAction(actionId, correlationId, command.parameters);
      } catch (err) {
        // Network or bridge failure during write execution -> Search Before Retry!
        const recovered = await this.idempotencyResolver.searchExistingAppointment({
          appointmentId: (command.parameters.appointmentId || command.parameters.id) as string | undefined,
          patientId: command.parameters.patientId as string | undefined,
          providerId: command.parameters.providerId as string | undefined,
          startTime: command.parameters.startTime as string | undefined,
        });

        if (recovered) {
          writeAlreadySucceeded = true;
          existingRecord = recovered;
          actionResult = { status: 'SUCCESS', data: recovered };
        } else {
          const retryResult = fsm.markRetryable((err as Error).message || 'Transient error during action execution');
          await this.resultReporter.report(command.commandId, retryResult);
          await this.clearInFlightCommand(command.commandId);
          return retryResult;
        }
      }

      // Handle action result status
      if (actionResult.status === 'CONFLICT') {
        const errorObj = (actionResult.error as Record<string, unknown>) || {};
        const resolution = await this.idempotencyResolver.resolveConflict(
          command.action,
          command.parameters,
          errorObj
        );

        if (resolution.isIdempotentMatch && resolution.existingRecord) {
          writeAlreadySucceeded = true;
          existingRecord = resolution.existingRecord;
        } else {
          const conflictResult = fsm.markConflict(resolution.reason || 'CMS Conflict');
          await this.resultReporter.report(command.commandId, conflictResult);
          await this.clearInFlightCommand(command.commandId);
          return conflictResult;
        }
      } else if (actionResult.status !== 'SUCCESS') {
        const errorObj = (actionResult.error as Record<string, unknown>) || {};
        const reason = (errorObj.message as string) || `Action execution returned status ${actionResult.status}`;
        const failResult = fsm.markTerminalFailure(reason);
        await this.resultReporter.report(command.commandId, failResult);
        await this.clearInFlightCommand(command.commandId);
        return failResult;
      }

      // --- Step 6: Capture Raw Write Receipt ---
      if (!writeAlreadySucceeded) {
        const dataObj = (actionResult.data as Record<string, unknown>) || {};
        rawReceiptId =
          (dataObj.id as string | undefined) ||
          (command.parameters.appointmentId as string | undefined) ||
          (command.parameters.id as string | undefined);
        rawReceiptRev = typeof dataObj.rev === 'number' ? dataObj.rev : 1;
        resolvedPatientId =
          (dataObj.resolvedPatientId as string | undefined) ||
          (dataObj.patientId as string | undefined);
        resolvedProviderId =
          (dataObj.resolvedProviderId as string | undefined) ||
          (dataObj.providerId as string | undefined);
      }
    }

    if (writeAlreadySucceeded && existingRecord) {
      rawReceiptId = existingRecord.id as string;
      rawReceiptRev = typeof existingRecord.rev === 'number' ? existingRecord.rev : 1;
    }

    if (!rawReceiptId) {
      const failResult = fsm.markTerminalFailure('Could not identify target entity ID for verification');
      await this.resultReporter.report(command.commandId, failResult);
      await this.clearInFlightCommand(command.commandId);
      return failResult;
    }

    // --- Step 7: Independent Read-Back (AGENTS.md Rule 10) ---
    if (fsm.getState() === 'LEASED') {
      fsm.startExecuting();
    }
    fsm.startVerifying();
    await this.saveInFlightCommand(fsm);

    const isPatient = actionId === ACTION_PATIENT_CREATE;
    let readEntity: Record<string, unknown> | null =
      writeAlreadySucceeded && existingRecord ? existingRecord : null;

    if (!readEntity && this.actionDispatcher) {
      const verifyActionId = isPatient ? ACTION_PATIENT_VERIFY : ACTION_APPOINTMENT_VERIFY;
      const verifyCorrelationId = `verify-${command.commandId}-${Date.now()}`;
      const verifyParams = isPatient
        ? { patientId: rawReceiptId }
        : { appointmentId: rawReceiptId };

      try {
        const verifyRes = await this.actionDispatcher(verifyActionId, verifyCorrelationId, verifyParams);
        if (verifyRes && verifyRes.status === 'SUCCESS' && verifyRes.data) {
          const d = verifyRes.data as Record<string, unknown>;
          if (d.patientId || d.patient_id || d.startTime || d.start_time || d.fullName || d.full_name) {
            readEntity = d;
          }
        }
      } catch {
        // Fallback to direct fetchFn below
      }
    }

    if (!readEntity) {
      let readEndpoint: string;
      if (this.adapterManifest?.recipes) {
        const recipeKey = isPatient ? 'patients.create' : 'appointments.create';
        const fallbackKey = isPatient ? 'patients_create' : 'appointments_create';
        const verifyPath =
          this.adapterManifest.recipes[recipeKey]?.verification?.path ||
          this.adapterManifest.recipes[fallbackKey]?.verification?.path ||
          (isPatient ? this.adapterManifest.endpoints?.patients?.get : this.adapterManifest.endpoints?.appointments?.reschedule);
        if (verifyPath) {
          const pathWithId = verifyPath.replace(':id', encodeURIComponent(rawReceiptId));
          readEndpoint = `${this.targetOrigin}${pathWithId.startsWith('/') ? '' : '/'}${pathWithId}`;
        } else {
          readEndpoint = isPatient
            ? `${this.targetOrigin}/api/patients/${encodeURIComponent(rawReceiptId)}`
            : `${this.targetOrigin}/api/appointments/${encodeURIComponent(rawReceiptId)}`;
        }
      } else {
        readEndpoint = isPatient
          ? `${this.targetOrigin}/api/patients/${encodeURIComponent(rawReceiptId)}`
          : `${this.targetOrigin}/api/appointments/${encodeURIComponent(rawReceiptId)}`;
      }

      let readRes: Response;
      const isCrossOriginRead =
        readEndpoint.startsWith('http') &&
        Boolean(this.targetOrigin) &&
        !readEndpoint.startsWith(this.targetOrigin);
      try {
        readRes = await this.fetchFn(readEndpoint, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: isCrossOriginRead ? 'omit' : 'include',
        });
      } catch (err) {
        const retryResult = fsm.markRetryable(`Read-back request failed: ${(err as Error).message}`);
        await this.resultReporter.report(command.commandId, retryResult);
        await this.clearInFlightCommand(command.commandId);
        return retryResult;
      }

      if (!readRes.ok) {
        const conflictResult = fsm.markConflict(
          `Read-back entity '${rawReceiptId}' failed with HTTP ${readRes.status}`
        );
        await this.resultReporter.report(command.commandId, conflictResult);
        await this.clearInFlightCommand(command.commandId);
        return conflictResult;
      }

      let readBackJson: Record<string, unknown>;
      try {
        readBackJson = (await readRes.json()) as Record<string, unknown>;
      } catch {
        const conflictResult = fsm.markConflict('Read-back returned non-JSON payload');
        await this.resultReporter.report(command.commandId, conflictResult);
        await this.clearInFlightCommand(command.commandId);
        return conflictResult;
      }

      readEntity = ((readBackJson.data as Record<string, unknown>) || readBackJson) as Record<string, unknown>;
    }

    // --- Step 8: Verification Diff ---
    const diffResult = verifyReadBackRecord(command.action, command.parameters, readEntity, {
      idParam: 'id',
      revisionPath: 'rev',
      resolvedPatientId,
      resolvedProviderId,
    });

    if (!diffResult.verified) {
      // Rule 10: Never report VERIFIED if mismatch detected
      const conflictResult = fsm.markConflict(diffResult.reason || 'Verification diff failed');
      await this.resultReporter.report(command.commandId, conflictResult);
      await this.clearInFlightCommand(command.commandId);
      return conflictResult;
    }

    // --- Step 9: Report Verified Receipt ---
    // Assert fencing token is still valid before reporting
    const currentLease = this.leaseCoordinator.getActiveLease();
    if (!currentLease || currentLease.fencingToken !== activeLease.fencingToken) {
      throw new FencingTokenError(activeLease.fencingToken, currentLease?.fencingToken ?? 0);
    }

    const verifiedReceipt: WriteReceipt = diffResult.writeReceipt ?? {
      externalId: rawReceiptId,
      revision: rawReceiptRev,
      verifiedAt: new Date().toISOString(),
    };

    const verifiedResult = fsm.markVerified(verifiedReceipt);

    // Tag in echo suppressor so inbound observation does not re-emit
    this.echoSuppressor.recordOutboundWrite({
      entityType: isPatient ? 'patient' : 'appointment',
      entityId: verifiedReceipt.externalId,
      revision: verifiedReceipt.revision,
      providerId: command.parameters.providerId as string | undefined,
      startTime: command.parameters.startTime as string | undefined,
    });

    await this.resultReporter.report(command.commandId, verifiedResult);

    // --- Step 10: Clear Transient State ---
    await this.clearInFlightCommand(command.commandId);

    return verifiedResult;
  }

  private async saveInFlightCommand(fsm: CommandFSM): Promise<void> {
    try {
      // AGENTS.md Rule 6: Do not store raw PHI in storage.
      // Store only command lifecycle metadata
      const snapshot = {
        commandId: fsm.commandId,
        action: fsm.action,
        state: fsm.getState(),
        fencingToken: fsm.getFencingToken(),
        retryCount: fsm.getRetryCount(),
        lastUpdatedAt: fsm.getLastUpdatedAt(),
      };
      await this.storage.set({ [IN_FLIGHT_COMMAND_KEY]: snapshot });
    } catch {
      // ignore
    }
  }

  async clearInFlightCommand(commandId?: string): Promise<void> {
    try {
      if (!commandId) {
        await this.storage.remove(IN_FLIGHT_COMMAND_KEY);
        return;
      }
      const res = await this.storage.get(IN_FLIGHT_COMMAND_KEY);
      const cur = res[IN_FLIGHT_COMMAND_KEY] as { commandId?: string } | undefined;
      if (!cur || cur.commandId === commandId) {
        await this.storage.remove(IN_FLIGHT_COMMAND_KEY);
      }
    } catch {
      // ignore
    }
  }

  async getInFlightCommand(): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.storage.get(IN_FLIGHT_COMMAND_KEY);
      const snapshot = (res[IN_FLIGHT_COMMAND_KEY] as Record<string, unknown>) ?? null;
      if (!snapshot) return null;

      // Timeout check: clear stale in-flight commands older than 5 minutes
      const lastUpdated = typeof snapshot.lastUpdatedAt === 'string' ? new Date(snapshot.lastUpdatedAt).getTime() : 0;
      if (lastUpdated > 0 && Date.now() - lastUpdated > 5 * 60 * 1000) {
        await this.storage.remove(IN_FLIGHT_COMMAND_KEY);
        return null;
      }

      return snapshot;
    } catch {
      return null;
    }
  }
}
