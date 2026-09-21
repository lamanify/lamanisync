/**
 * Outbox Result Dispatcher (Phase 8)
 * Dispatches read-after-write verification receipts and error statuses back to LamaniHub.
 * Conforms to AGENTS.md Rule 4: Never transmit secrets.
 */

import { SyncApiClient } from './api-client.js';
import { type CommandResult, CommandResultSchema } from '../core/contracts/commands.js';
import { LamaniError } from '../core/errors.js';

export interface ResultReporterOptions {
  apiClient: SyncApiClient;
  maxRetries?: number;
}

export class ResultReporter {
  private apiClient: SyncApiClient;
  private maxRetries: number;

  constructor(options: ResultReporterOptions) {
    this.apiClient = options.apiClient;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Reports the final or terminal outcome of a command execution to LamaniHub.
   */
  async report(
    commandId: string,
    result: CommandResult
  ): Promise<{ acknowledged: boolean; commandId: string; status: string }> {
    const validated = CommandResultSchema.parse(result);

    let attempts = 0;
    let lastError: unknown;

    while (attempts < this.maxRetries) {
      attempts += 1;
      try {
        const response = await this.apiClient.reportCommandResult(commandId, {
          status: validated.status,
          writeReceipt: validated.writeReceipt,
          error: validated.error,
        });
        return response;
      } catch (err) {
        lastError = err;
        if (attempts >= this.maxRetries) {
          break;
        }
        // Brief backoff before retrying result upload
        await new Promise((r) => setTimeout(r, 200 * attempts));
      }
    }

    throw new LamaniError(
      `Failed to report command result to Sync API after ${attempts} attempts`,
      'SYNC_API_ERROR',
      { cause: lastError }
    );
  }
}
