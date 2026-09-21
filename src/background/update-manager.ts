/**
 * Update Manager (Phase 11)
 * Handles extension updates during active leased command execution.
 * Conforms strictly to AGENTS.md:
 * Rule 7: Ephemeral SW correctness survives restarts.
 * Rule 10: An appointment is not confirmed until the CMS write is read back and verified.
 * Never reloads mid-command execution; defers update until write receipt is verified.
 */

import type { CommandExecutor } from './command-executor.js';
import type { LeaseCoordinator } from './lease-client.js';

export interface UpdateDetails {
  version: string;
}

export class UpdateManager {
  private deferredUpdate: UpdateDetails | null = null;
  private commandExecutor: CommandExecutor;
  private leaseCoordinator: LeaseCoordinator;
  private reloadFn: () => void;

  constructor(options: {
    commandExecutor: CommandExecutor;
    leaseCoordinator: LeaseCoordinator;
    reloadFn?: () => void;
  }) {
    this.commandExecutor = options.commandExecutor;
    this.leaseCoordinator = options.leaseCoordinator;
    this.reloadFn =
      options.reloadFn ||
      (() => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.reload) {
          chrome.runtime.reload();
        }
      });
  }

  /**
   * Called when chrome.runtime.onUpdateAvailable fires.
   * Defers reload if a command is currently leased or executing.
   */
  async handleUpdateAvailable(details: UpdateDetails): Promise<{ deferred: boolean }> {
    const inFlight = await this.commandExecutor.getInFlightCommand();
    const isBusy = inFlight !== null || this.leaseCoordinator.hasActiveLease();

    if (isBusy) {
      this.deferredUpdate = details;
      return { deferred: true };
    }

    this.applyUpdate();
    return { deferred: false };
  }

  hasDeferredUpdate(): boolean {
    return this.deferredUpdate !== null;
  }

  getDeferredUpdate(): UpdateDetails | null {
    return this.deferredUpdate;
  }

  /**
   * Called after a command execution completes and write receipt is verified.
   */
  async onCommandSettled(): Promise<boolean> {
    if (!this.deferredUpdate) return false;

    const inFlight = await this.commandExecutor.getInFlightCommand();
    if (!inFlight) {
      if (this.leaseCoordinator.hasActiveLease()) {
        try {
          await this.leaseCoordinator.release();
        } catch {
          // ignore release errors during reload
        }
      }
      this.deferredUpdate = null;
      this.applyUpdate();
      return true;
    }
    return false;
  }

  private applyUpdate(): void {
    this.reloadFn();
  }
}
