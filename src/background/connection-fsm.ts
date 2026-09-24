import {
  type ConnectionState,
  type ConnectionStateRecord,
  ConnectionStateRecordSchema,
} from '../core/contracts/connection.js';
import { IllegalTransitionError } from '../core/errors.js';

/**
 * Explicit map of legal transitions for LamaniSync connection lifecycle.
 * Fails closed on any transition not explicitly listed.
 */
const LEGAL_TRANSITIONS: Record<ConnectionState, readonly ConnectionState[]> = {
  UNPAIRED: ['PAIRING'],
  PAIRING: ['PAIRED_NO_PERMISSION', 'UNPAIRED', 'REVOKED'],
  PAIRED_NO_PERMISSION: ['PROBING', 'UNPAIRED', 'REVOKED'],
  PROBING: ['SHADOW', 'REAUTH_REQUIRED', 'DEGRADED', 'PAUSED', 'REVOKED', 'UNPAIRED', 'PAIRED_NO_PERMISSION'],
  SHADOW: ['ACTIVE', 'REAUTH_REQUIRED', 'DEGRADED', 'PAUSED', 'REVOKED', 'UNPAIRED', 'PAIRED_NO_PERMISSION'],
  ACTIVE: ['REAUTH_REQUIRED', 'DEGRADED', 'PAUSED', 'REVOKED', 'UNPAIRED', 'PAIRED_NO_PERMISSION'],
  REAUTH_REQUIRED: ['PROBING', 'ACTIVE', 'REVOKED', 'UNPAIRED', 'PAIRED_NO_PERMISSION'],
  DEGRADED: ['PROBING', 'ACTIVE', 'PAUSED', 'REVOKED', 'UNPAIRED', 'PAIRED_NO_PERMISSION'],
  PAUSED: ['ACTIVE', 'SHADOW', 'PROBING', 'REAUTH_REQUIRED', 'DEGRADED', 'REVOKED', 'UNPAIRED', 'PAIRED_NO_PERMISSION'],
  REVOKED: ['UNPAIRED'],
};

export interface TransitionOptions {
  reason: string;
  timestamp?: string;
  targetOrigin?: string | null;
  connectionId?: string | null;
  installationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type ConnectionListener = (
  record: ConnectionStateRecord,
  prevRecord: ConnectionStateRecord
) => void;

export class ConnectionFSM {
  private currentRecord: ConnectionStateRecord;
  private listeners: Set<ConnectionListener> = new Set();

  constructor(initialRecord?: Partial<ConnectionStateRecord>) {
    const baseline: ConnectionStateRecord = {
      state: initialRecord?.state ?? 'UNPAIRED',
      reason: initialRecord?.reason ?? 'Initial initialized state',
      timestamp: initialRecord?.timestamp ?? new Date().toISOString(),
      connectionId: initialRecord?.connectionId,
      installationId: initialRecord?.installationId,
      targetOrigin: initialRecord?.targetOrigin,
      metadata: initialRecord?.metadata,
    };

    this.currentRecord = ConnectionStateRecordSchema.parse(baseline);
  }

  getState(): ConnectionState {
    return this.currentRecord.state;
  }

  getRecord(): Readonly<ConnectionStateRecord> {
    return Object.freeze({ ...this.currentRecord });
  }

  canTransition(nextState: ConnectionState): boolean {
    const allowed = LEGAL_TRANSITIONS[this.currentRecord.state];
    return allowed.includes(nextState);
  }

  transition(nextState: ConnectionState, options: TransitionOptions): ConnectionStateRecord {
    if (!options.reason || !options.reason.trim()) {
      throw new Error('Transition requires a non-empty reason');
    }

    if (!this.canTransition(nextState)) {
      throw new IllegalTransitionError(
        this.currentRecord.state,
        nextState,
        options.reason
      );
    }

    const prevRecord = this.currentRecord;
    const isReset = nextState === 'UNPAIRED';

    const resolveField = <T>(optVal: T | null | undefined, currentVal: T | undefined): T | undefined => {
      if (optVal === null) return undefined;
      if (optVal !== undefined) return optVal;
      return isReset ? undefined : currentVal;
    };

    const nextRecord: ConnectionStateRecord = {
      state: nextState,
      reason: options.reason.trim(),
      timestamp: options.timestamp ?? new Date().toISOString(),
      connectionId: resolveField(options.connectionId, this.currentRecord.connectionId),
      installationId: resolveField(options.installationId, this.currentRecord.installationId),
      targetOrigin: resolveField(options.targetOrigin, this.currentRecord.targetOrigin),
      metadata: resolveField(options.metadata, this.currentRecord.metadata),
    };

    // Validate with Zod before committing
    this.currentRecord = ConnectionStateRecordSchema.parse(nextRecord);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(this.currentRecord, prevRecord);
      } catch (err) {
        console.error('Error in ConnectionFSM listener:', err);
      }
    }

    return this.getRecord();
  }

  onTransition(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateMetadata(metadataUpdate: Record<string, unknown>): ConnectionStateRecord {
    this.currentRecord = ConnectionStateRecordSchema.parse({
      ...this.currentRecord,
      metadata: {
        ...(this.currentRecord.metadata || {}),
        ...metadataUpdate,
      },
    });

    for (const listener of this.listeners) {
      try {
        listener(this.currentRecord, this.currentRecord);
      } catch (err) {
        console.error('Error in ConnectionFSM listener:', err);
      }
    }

    return this.getRecord();
  }

  toJSON(): ConnectionStateRecord {
    return this.currentRecord;
  }

  static fromJSON(data: unknown): ConnectionFSM {
    const validated = ConnectionStateRecordSchema.parse(data);
    return new ConnectionFSM(validated);
  }
}
