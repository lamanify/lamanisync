import {
  type CommandStatus,
  type SyncCommand,
  type WriteReceipt,
  type CommandResult,
  SyncCommandSchema,
  WriteReceiptSchema,
} from './contracts/commands.js';
import { IllegalTransitionError, FencingTokenError } from './errors.js';

const LEGAL_COMMAND_TRANSITIONS: Record<CommandStatus, readonly CommandStatus[]> = {
  PENDING: ['LEASED', 'TERMINAL_FAILURE'],
  LEASED: ['EXECUTING', 'CONFLICT', 'RETRYABLE', 'TERMINAL_FAILURE'],
  EXECUTING: ['VERIFYING', 'CONFLICT', 'RETRYABLE', 'TERMINAL_FAILURE'],
  VERIFYING: ['VERIFIED', 'CONFLICT', 'RETRYABLE', 'TERMINAL_FAILURE'],
  RETRYABLE: ['PENDING', 'LEASED', 'TERMINAL_FAILURE'],
  VERIFIED: [],
  CONFLICT: [],
  TERMINAL_FAILURE: [],
};

export interface CommandFSMOptions {
  maxRetries?: number;
  fencingToken?: number;
  initialState?: CommandStatus;
  retryCount?: number;
  failureReason?: string;
  writeReceipt?: WriteReceipt;
  lastUpdatedAt?: string;
}

export class CommandFSM {
  readonly commandId: string;
  readonly action: string;
  readonly parameters: Record<string, unknown>;
  private state: CommandStatus;
  private fencingToken: number;
  private retryCount: number;
  readonly maxRetries: number;
  private writeReceipt?: WriteReceipt;
  private failureReason?: string;
  private lastUpdatedAt: string;

  constructor(command: SyncCommand, options: CommandFSMOptions = {}) {
    this.commandId = command.commandId;
    this.action = command.action;
    this.parameters = command.parameters;
    this.state = options.initialState ?? (command.status as CommandStatus) ?? 'PENDING';
    this.fencingToken = options.fencingToken ?? command.fencingToken ?? 0;
    this.retryCount = options.retryCount ?? 0;
    this.maxRetries = options.maxRetries ?? 3;
    this.failureReason = options.failureReason;
    this.writeReceipt = options.writeReceipt;
    this.lastUpdatedAt = options.lastUpdatedAt ?? new Date().toISOString();
  }

  getState(): CommandStatus {
    return this.state;
  }

  getFencingToken(): number {
    return this.fencingToken;
  }

  getRetryCount(): number {
    return this.retryCount;
  }

  getWriteReceipt(): WriteReceipt | undefined {
    return this.writeReceipt;
  }

  getFailureReason(): string | undefined {
    return this.failureReason;
  }

  getLastUpdatedAt(): string {
    return this.lastUpdatedAt;
  }

  private validateTransition(nextState: CommandStatus): void {
    const allowed = LEGAL_COMMAND_TRANSITIONS[this.state];
    if (!allowed.includes(nextState)) {
      throw new IllegalTransitionError(this.state, nextState);
    }
  }

  /**
   * Acquire a lease on the command with a monotonic fencing token.
   */
  lease(fencingToken: number): void {
    this.validateTransition('LEASED');

    if (fencingToken <= 0) {
      throw new Error('Fencing token must be positive');
    }

    if (fencingToken <= this.fencingToken) {
      throw new FencingTokenError(this.fencingToken, fencingToken);
    }

    this.fencingToken = fencingToken;
    this.state = 'LEASED';
    this.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Begin executing against the target CMS.
   */
  startExecuting(): void {
    this.validateTransition('EXECUTING');
    this.state = 'EXECUTING';
    this.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Write completed on CMS; begin read-after-write verification.
   */
  startVerifying(): void {
    this.validateTransition('VERIFYING');
    this.state = 'VERIFYING';
    this.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Verified read-after-write matches expected state.
   */
  markVerified(receipt: WriteReceipt): CommandResult {
    this.validateTransition('VERIFIED');
    this.writeReceipt = receipt;
    this.state = 'VERIFIED';
    this.lastUpdatedAt = new Date().toISOString();

    return {
      status: 'VERIFIED',
      commandId: this.commandId,
      writeReceipt: receipt,
      acknowledged: true,
      occurredAt: this.lastUpdatedAt,
    };
  }

  /**
   * Transition to CONFLICT (e.g. 409 revision mismatch or slot collision).
   */
  markConflict(reason: string, details?: Record<string, unknown>): CommandResult {
    this.validateTransition('CONFLICT');
    this.state = 'CONFLICT';
    this.failureReason = reason;
    this.lastUpdatedAt = new Date().toISOString();

    return {
      status: 'CONFLICT',
      commandId: this.commandId,
      error: { message: reason, ...details },
      acknowledged: false,
      occurredAt: this.lastUpdatedAt,
    };
  }

  /**
   * Mark command retryable. Automatically converts to TERMINAL_FAILURE if retry limit exceeded.
   */
  markRetryable(reason: string): CommandResult {
    this.retryCount += 1;
    this.failureReason = reason;
    this.lastUpdatedAt = new Date().toISOString();

    if (this.retryCount > this.maxRetries) {
      // Exceeded max retries -> fail terminally
      this.validateTransition('TERMINAL_FAILURE');
      this.state = 'TERMINAL_FAILURE';
      return {
        status: 'TERMINAL_FAILURE',
        commandId: this.commandId,
        error: { message: `Max retries (${this.maxRetries}) exceeded: ${reason}` },
        acknowledged: false,
        occurredAt: this.lastUpdatedAt,
      };
    }

    this.validateTransition('RETRYABLE');
    this.state = 'RETRYABLE';

    return {
      status: 'RETRYABLE',
      commandId: this.commandId,
      error: { message: reason, retryCount: this.retryCount },
      acknowledged: false,
      occurredAt: this.lastUpdatedAt,
    };
  }

  /**
   * Re-queue a RETRYABLE command back into PENDING state.
   */
  requeue(): void {
    this.validateTransition('PENDING');
    this.state = 'PENDING';
    this.lastUpdatedAt = new Date().toISOString();
  }

  /**
   * Non-retryable terminal failure (e.g. bad request, unsupported action).
   */
  markTerminalFailure(reason: string): CommandResult {
    this.validateTransition('TERMINAL_FAILURE');
    this.state = 'TERMINAL_FAILURE';
    this.failureReason = reason;
    this.lastUpdatedAt = new Date().toISOString();

    return {
      status: 'TERMINAL_FAILURE',
      commandId: this.commandId,
      error: { message: reason },
      acknowledged: false,
      occurredAt: this.lastUpdatedAt,
    };
  }

  toJSON(): Record<string, unknown> {
    return {
      commandId: this.commandId,
      action: this.action,
      parameters: this.parameters,
      state: this.state,
      fencingToken: this.fencingToken,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
      failureReason: this.failureReason,
      writeReceipt: this.writeReceipt,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  static fromJSON(data: unknown): CommandFSM {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid serialized CommandFSM data: expected an object');
    }
    const d = data as Record<string, unknown>;
    const command = SyncCommandSchema.parse({
      commandId: d.commandId,
      action: d.action,
      parameters: d.parameters,
      fencingToken: d.fencingToken,
      status: d.state ?? d.status,
    });

    return new CommandFSM(command, {
      fencingToken: typeof d.fencingToken === 'number' ? d.fencingToken : undefined,
      maxRetries: typeof d.maxRetries === 'number' ? d.maxRetries : undefined,
      initialState: (d.state ?? d.status) as CommandStatus,
      retryCount: typeof d.retryCount === 'number' ? d.retryCount : 0,
      failureReason: typeof d.failureReason === 'string' ? d.failureReason : undefined,
      writeReceipt: d.writeReceipt ? WriteReceiptSchema.parse(d.writeReceipt) : undefined,
      lastUpdatedAt: typeof d.lastUpdatedAt === 'string' ? d.lastUpdatedAt : undefined,
    });
  }
}
