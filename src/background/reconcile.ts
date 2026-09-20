/**
 * Reconciliation Worker (Phase 7)
 * Compares server-reported event state against live CMS data to detect and repair missed events.
 * Strictly adheres to AGENTS.md:
 * Rule 4: Zero passwords, cookies, or secrets transmitted.
 * Rule 7: Ephemeral SW safe; requires active leader lease to prevent duplicate repairs.
 * Rule 9: Runtime validation of all network inputs.
 */

import { SyncApiClient } from './api-client.js';
import { LeaseCoordinator } from './lease-client.js';
import { BatchUploader } from './batch-uploader.js';
import {
  normalizePatientSyncEvent,
  normalizeAppointmentSyncEvent,
} from '../core/event-normalizer.js';
import { type SyncEvent } from '../core/contracts/events.js';

import { ConnectionFSM } from './connection-fsm.js';

export interface ReconcileResult {
  status: 'OK' | 'REPAIRED' | 'SKIPPED' | 'ERROR';
  inspectedCount: number;
  repairedCount: number;
  repairedIds: string[];
  error?: string;
}

export interface ReconcileWorkerOptions {
  leaseCoordinator: LeaseCoordinator;
  apiClient: SyncApiClient;
  batchUploader: BatchUploader;
  targetOrigin: string;
  connectionId: string;
  installationId?: string;
  fsm?: ConnectionFSM;
  fetchFn?: typeof fetch;
}

export class ReconcileWorker {
  private leaseCoordinator: LeaseCoordinator;
  private apiClient: SyncApiClient;
  private batchUploader: BatchUploader;
  private targetOrigin: string;
  private connectionId: string;
  private installationId?: string;
  private fsm?: ConnectionFSM;
  private fetchFn: typeof fetch;

  constructor(options: ReconcileWorkerOptions) {
    this.leaseCoordinator = options.leaseCoordinator;
    this.apiClient = options.apiClient;
    this.batchUploader = options.batchUploader;
    this.targetOrigin = options.targetOrigin.replace(/\/$/, '');
    this.connectionId = options.connectionId;
    this.installationId = options.installationId;
    this.fsm = options.fsm;
    this.fetchFn = options.fetchFn || ((...args) => globalThis.fetch(...args));
  }

  /**
   * Executes a single reconciliation pass.
   */
  async runReconciliation(): Promise<ReconcileResult> {
    // 1. Leader Lease check: only active leader runs reconciliation
    if (!this.leaseCoordinator.hasActiveLease()) {
      return {
        status: 'SKIPPED',
        inspectedCount: 0,
        repairedCount: 0,
        repairedIds: [],
        error: 'No active leader lease held',
      };
    }

    try {
      // 2. Fetch Sync API state summary
      const summary = await this.apiClient.getReconcileSummary(this.connectionId);
      const knownPatients = new Set(summary.knownEntityIds?.patient || []);
      const knownAppointments = new Set(summary.knownEntityIds?.appointment || []);
      const entityRevisions = summary.entityRevisions || {};

      const missedEvents: SyncEvent[] = [];
      const repairedIds: string[] = [];
      let inspectedCount = 0;

      // 3. Inspect CMS Patients
      const patientsUrl = `${this.targetOrigin}/api/patients?limit=200`;
      const patientsRes = await this.fetchFn(patientsUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });

      if (patientsRes.status === 401) {
        if (this.fsm?.canTransition('REAUTH_REQUIRED')) {
          this.fsm.transition('REAUTH_REQUIRED', {
            reason: 'CMS session expired during reconciliation (HTTP 401)',
            connectionId: this.connectionId,
            installationId: this.installationId || '',
            targetOrigin: this.targetOrigin,
          });
        }
        return {
          status: 'ERROR',
          inspectedCount,
          repairedCount: 0,
          repairedIds: [],
          error: 'UNAUTHORIZED',
        };
      }

      if (patientsRes.ok) {
        const pJson = (await patientsRes.json()) as Record<string, unknown>;
        const patients = (pJson.data ?? pJson) as Array<Record<string, unknown>>;
        if (Array.isArray(patients)) {
          inspectedCount += patients.length;
          for (const patient of patients) {
            const id = String(patient.id || '');
            if (id && !knownPatients.has(id)) {
              // Missed patient detected!
              missedEvents.push(normalizePatientSyncEvent(patient));
              repairedIds.push(id);
            }
          }
        }
      }

      // 4. Inspect CMS Appointments
      const apptsUrl = `${this.targetOrigin}/api/appointments?limit=200`;
      const apptsRes = await this.fetchFn(apptsUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });

      if (apptsRes.status === 401) {
        if (this.fsm?.canTransition('REAUTH_REQUIRED')) {
          this.fsm.transition('REAUTH_REQUIRED', {
            reason: 'CMS session expired during reconciliation (HTTP 401)',
            connectionId: this.connectionId,
            installationId: this.installationId || '',
            targetOrigin: this.targetOrigin,
          });
        }
        return {
          status: 'ERROR',
          inspectedCount,
          repairedCount: 0,
          repairedIds: [],
          error: 'UNAUTHORIZED',
        };
      }

      if (apptsRes.ok) {
        const aJson = (await apptsRes.json()) as Record<string, unknown>;
        const appointments = (aJson.data ?? aJson) as Array<Record<string, unknown>>;
        if (Array.isArray(appointments)) {
          inspectedCount += appointments.length;
          for (const appt of appointments) {
            const id = String(appt.id || '');
            const rev = Number(appt.revision ?? appt.rev ?? 1);
            const knownRev = entityRevisions[id] || 0;

            if (id && (!knownAppointments.has(id) || rev > knownRev)) {
              // Missed or outdated appointment detected!
              missedEvents.push(normalizeAppointmentSyncEvent(appt));
              repairedIds.push(id);
            }
          }
        }
      }

      // 5. Repair missed events via Batch Uploader (force: true bypasses local duplicate check since server missed them)
      if (missedEvents.length > 0) {
        await this.batchUploader.enqueue(missedEvents, { force: true });
        await this.batchUploader.flush();
      }

      return {
        status: missedEvents.length > 0 ? 'REPAIRED' : 'OK',
        inspectedCount,
        repairedCount: missedEvents.length,
        repairedIds,
      };
    } catch (err) {
      return {
        status: 'ERROR',
        inspectedCount: 0,
        repairedCount: 0,
        repairedIds: [],
        error: (err as Error).message || 'Reconciliation failed',
      };
    }
  }
}
