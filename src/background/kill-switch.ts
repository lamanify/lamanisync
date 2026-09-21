/**
 * Remote Kill-Switch Coordinator (Phase 10)
 * Evaluates remote pause and kill-switch signals across global, adapter, and connection levels.
 * Immediately halts background polling and transitions ConnectionFSM to PAUSED.
 * Conforms to AGENTS.md Rules 7, 9, 14.
 */

import { ConnectionFSM } from './connection-fsm.js';

export type KillSwitchLevel = 'global' | 'adapter' | 'connection';

export interface KillSwitchEvent {
  level: KillSwitchLevel;
  targetId?: string;
  reason: string;
  timestamp: string;
}

export interface KillSwitchCoordinatorOptions {
  fsm: ConnectionFSM;
  onPauseTriggered?: (event: KillSwitchEvent) => void;
}

export class KillSwitchCoordinator {
  private fsm: ConnectionFSM;
  private globalPaused: boolean = false;
  private globalReason: string = '';
  private pausedAdapters: Map<string, string> = new Map();
  private pausedConnections: Map<string, string> = new Map();
  private onPauseTriggered?: (event: KillSwitchEvent) => void;

  constructor(options: KillSwitchCoordinatorOptions) {
    this.fsm = options.fsm;
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
   */
  resume(level?: KillSwitchLevel, targetId?: string): void {
    if (!level || level === 'global') {
      this.globalPaused = false;
      this.globalReason = '';
    }
    if ((!level || level === 'adapter') && targetId) {
      this.pausedAdapters.delete(targetId);
    }
    if ((!level || level === 'connection') && targetId) {
      this.pausedConnections.delete(targetId);
    }

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
  }
}
