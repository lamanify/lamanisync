/**
 * Remote Kill-Switch Coordinator (Phase 10)
 * Evaluates remote pause and kill-switch signals across global, adapter, and connection levels.
 * Immediately halts background polling and transitions ConnectionFSM to PAUSED.
 * Conforms to AGENTS.md Rules 7, 9, 14.
 */

import { ConnectionFSM } from './connection-fsm.js';
import { type StorageAdapter } from './pairing.js';

export type KillSwitchLevel = 'global' | 'adapter' | 'connection';

export const KILL_SWITCH_STORAGE_KEY = 'lamanisync_kill_switch_state';

export interface KillSwitchEvent {
  level: KillSwitchLevel;
  targetId?: string;
  reason: string;
  timestamp: string;
}

export interface KillSwitchCoordinatorOptions {
  fsm: ConnectionFSM;
  storage?: StorageAdapter;
  onPauseTriggered?: (event: KillSwitchEvent) => void;
}

export class KillSwitchCoordinator {
  private fsm: ConnectionFSM;
  private storage?: StorageAdapter;
  private globalPaused: boolean = false;
  private globalReason: string = '';
  private pausedAdapters: Map<string, string> = new Map();
  private pausedConnections: Map<string, string> = new Map();
  private onPauseTriggered?: (event: KillSwitchEvent) => void;

  constructor(options: KillSwitchCoordinatorOptions) {
    this.fsm = options.fsm;
    this.storage = options.storage;
    this.onPauseTriggered = options.onPauseTriggered;
  }

  setPauseCallback(callback: (event: KillSwitchEvent) => void): void {
    this.onPauseTriggered = callback;
  }

  isGlobalPaused(): boolean {
    return this.globalPaused;
  }

  isAdapterPaused(adapterId: string): boolean {
    return this.pausedAdapters.has(adapterId);
  }

  isConnectionPaused(connectionId: string): boolean {
    return this.pausedConnections.has(connectionId);
  }

  /**
   * Checks whether operations are currently paused at any matching scope.
   */
  isPaused(options?: { adapterId?: string; connectionId?: string }): boolean {
    if (this.globalPaused) return true;
    if (options?.adapterId && this.pausedAdapters.has(options.adapterId)) return true;
    if (options?.connectionId && this.pausedConnections.has(options.connectionId)) return true;
    return this.fsm.getState() === 'PAUSED';
  }

  getPauseReason(options?: { adapterId?: string; connectionId?: string }): string | null {
    if (this.globalPaused) return this.globalReason || 'Global kill-switch active';
    if (options?.adapterId && this.pausedAdapters.has(options.adapterId)) {
      return this.pausedAdapters.get(options.adapterId) || `Adapter '${options.adapterId}' paused`;
    }
    if (options?.connectionId && this.pausedConnections.has(options.connectionId)) {
      return this.pausedConnections.get(options.connectionId) || `Connection '${options.connectionId}' paused`;
    }
    return null;
  }

  /**
   * Triggers pause at a specific level and enforces FSM transition to PAUSED.
   */
  triggerPause(level: KillSwitchLevel, targetId?: string, reason: string = 'Remote kill-switch signal'): void {
    const timestamp = new Date().toISOString();
    const event: KillSwitchEvent = {
      level,
      targetId,
      reason,
      timestamp,
    };

    if (level === 'global') {
      this.globalPaused = true;
      this.globalReason = reason;
    } else if (level === 'adapter' && targetId) {
      this.pausedAdapters.set(targetId, reason);
    } else if (level === 'connection' && targetId) {
      this.pausedConnections.set(targetId, reason);
    }

    this.persistState();

    // Immediately trigger callback (e.g. to halt polling)
    if (this.onPauseTriggered) {
      try {
        this.onPauseTriggered(event);
      } catch (err) {
        console.error('[KillSwitchCoordinator] Error in onPauseTriggered callback:', err);
      }
    }

    // Transition ConnectionFSM to PAUSED if allowable
    if (this.fsm.canTransition('PAUSED')) {
      this.fsm.transition('PAUSED', {
        reason: `Kill-switch activated [${level}${targetId ? `:${targetId}` : ''}]: ${reason}`,
        metadata: {
          killSwitchLevel: level,
          targetId,
          reason,
        },
      });
    }
  }

  /**
   * Inspects an API response or error payload for remote kill-switch indicators.
   * Recognizes 403 status, status: 'PAUSED', error: 'PAUSED', or killSwitchLevel flags.
   */
  processRemoteSignal(payload: unknown, defaultTargetId?: string): boolean {
    if (!payload || typeof payload !== 'object') return false;

    const data = payload as Record<string, unknown>;
    const isPausedStatus =
      data.status === 'PAUSED' ||
      data.error === 'PAUSED' ||
      data.paused === true ||
      data.killSwitch === true ||
      data.error === 'FORBIDDEN_PAUSED';

    if (isPausedStatus) {
      const level = (data.killSwitchLevel as KillSwitchLevel) || (data.level as KillSwitchLevel) || 'global';
      const targetId = (data.targetId as string) || defaultTargetId;
      const reason = (data.message as string) || (data.reason as string) || 'Remote kill-switch activated by Sync API';

      this.triggerPause(level, targetId, reason);
      return true;
    }

    return false;
  }

  /**
   * Clears pause state at specified level, allowing resumption if no other pause remains.
   * If targetId is omitted, clears all pauses at that level.
   */
  resume(level?: KillSwitchLevel, targetId?: string): void {
    if (!level || level === 'global') {
      this.globalPaused = false;
      this.globalReason = '';
    }
    if (!level || level === 'adapter') {
      if (targetId) {
        this.pausedAdapters.delete(targetId);
      } else {
        this.pausedAdapters.clear();
      }
    }
    if (!level || level === 'connection') {
      if (targetId) {
        this.pausedConnections.delete(targetId);
      } else {
        this.pausedConnections.clear();
      }
    }

    this.persistState();

    // If completely clear of pauses and currently in PAUSED state, can resume to ACTIVE
    if (!this.globalPaused && this.pausedAdapters.size === 0 && this.pausedConnections.size === 0) {
      if (this.fsm.getState() === 'PAUSED' && this.fsm.canTransition('ACTIVE')) {
        this.fsm.transition('ACTIVE', {
          reason: 'Remote kill-switch resolved; operations resumed',
        });
      }
    }
  }

  reset(): void {
    this.globalPaused = false;
    this.globalReason = '';
    this.pausedAdapters.clear();
    this.pausedConnections.clear();
    this.persistState();
  }

  private persistState(): void {
    if (this.storage) {
      this.storage
        .set({
          [KILL_SWITCH_STORAGE_KEY]: {
            globalPaused: this.globalPaused,
            globalReason: this.globalReason,
            pausedAdapters: Array.from(this.pausedAdapters.entries()),
            pausedConnections: Array.from(this.pausedConnections.entries()),
          },
        })
        .catch((err) => {
          console.warn('[KillSwitchCoordinator] Failed to persist pause state:', err);
        });
    }
  }

  async restore(): Promise<void> {
    if (!this.storage) return;
    try {
      const data = await this.storage.get(KILL_SWITCH_STORAGE_KEY);
      const raw = data[KILL_SWITCH_STORAGE_KEY] as
        | {
            globalPaused?: boolean;
            globalReason?: string;
            pausedAdapters?: [string, string][];
            pausedConnections?: [string, string][];
          }
        | undefined;

      if (raw) {
        this.globalPaused = Boolean(raw.globalPaused);
        this.globalReason = raw.globalReason || '';
        this.pausedAdapters = new Map(raw.pausedAdapters || []);
        this.pausedConnections = new Map(raw.pausedConnections || []);
      }
    } catch (err) {
      console.warn('[KillSwitchCoordinator] Failed to restore pause state from storage:', err);
    }
  }
}
