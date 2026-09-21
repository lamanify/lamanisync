/**
 * Operational Telemetry & Monitoring Evaluator (Phase 14)
 * Calculates operational metrics (heartbeat freshness, conflict rate, write verification error rate)
 * and evaluates alerting thresholds strictly adhering to AGENTS.md Rules 5, 6, and 14.
 */

import { z } from 'zod';

export type CommandOutcomeType =
  | 'success'
  | 'conflict'
  | 'verification_failure'
  | 'terminal_failure'
  | 'retryable';

export interface CommandMetricEvent {
  timestamp: number;
  outcome: CommandOutcomeType;
  correlationId?: string;
  durationMs?: number;
}

export interface OperatingHours {
  startHour: number; // 0-23
  endHour: number; // 0-23
  timezoneOffsetMinutes?: number; // e.g. 480 for UTC+8 (MYT)
}

export const DEFAULT_MYT_OPERATING_HOURS: OperatingHours = {
  startHour: 8,
  endHour: 22,
  timezoneOffsetMinutes: 480, // UTC+8
};

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface OperationalAlert {
  code: 'HEARTBEAT_STALE' | 'HIGH_CONFLICT_RATE' | 'HIGH_WRITE_FAILURE_RATE' | 'SCHEMA_DRIFT_DETECTED';
  severity: AlertSeverity;
  message: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export const ALERT_THRESHOLDS = {
  HEARTBEAT_MAX_STALENESS_MS: 15 * 60 * 1000, // 15 minutes
  CONFLICT_RATE_PERCENT_THRESHOLD: 2.0, // 2%
  WRITE_FAILURE_RATE_PERCENT_THRESHOLD: 0.5, // 0.5%
  MIN_SAMPLE_SIZE_FOR_RATE_ALERTS: 10,
};

/**
 * Validates that an object contains only telemetry counters/metadata and NO raw PHI.
 */
const PHI_PATTERNS = [
  /\b\d{6}-\d{2}-\d{4}\b/, // Malaysian NRIC
  /\b\+?60\d{8,10}\b/, // Malaysian phone
  /@/, // Email
];

export function assertNoRawPhiInMetrics(data: Record<string, unknown>): void {
  const json = JSON.stringify(data);
  for (const pattern of PHI_PATTERNS) {
    if (pattern.test(json)) {
      throw new Error(`[Telemetry] Potential PHI detected in telemetry payload matching ${pattern.source}`);
    }
  }
}

/**
 * Determines whether the given time falls within clinic operating hours.
 */
export function isWithinOperatingHours(
  currentMs: number,
  operatingHours: OperatingHours = DEFAULT_MYT_OPERATING_HOURS
): boolean {
  const offset = operatingHours.timezoneOffsetMinutes ?? 480;
  // Adjust to clinic timezone
  const clinicDate = new Date(currentMs + offset * 60 * 1000);
  const hour = clinicDate.getUTCHours();
  return hour >= operatingHours.startHour && hour < operatingHours.endHour;
}

/**
 * Checks if a heartbeat is stale (> 15 min without heartbeat during operating hours).
 */
export function isHeartbeatStale(
  lastHeartbeatMs: number,
  currentMs: number = Date.now(),
  operatingHours: OperatingHours = DEFAULT_MYT_OPERATING_HOURS
): boolean {
  if (!isWithinOperatingHours(currentMs, operatingHours)) {
    // Outside clinic operating hours, dormant/offline state is expected
    return false;
  }
  return currentMs - lastHeartbeatMs > ALERT_THRESHOLDS.HEARTBEAT_MAX_STALENESS_MS;
}

/**
 * Computes command conflict rate as a percentage of total finished commands.
 */
export function computeConflictRate(events: CommandMetricEvent[]): number {
  if (events.length === 0) return 0;
  const conflicts = events.filter((e) => e.outcome === 'conflict').length;
  return (conflicts / events.length) * 100;
}

/**
 * Computes write verification failure rate as a percentage of total finished commands.
 */
export function computeWriteFailureRate(events: CommandMetricEvent[]): number {
  if (events.length === 0) return 0;
  const failures = events.filter((e) => e.outcome === 'verification_failure').length;
  return (failures / events.length) * 100;
}

/**
 * Evaluates all operational alert conditions against current metrics.
 */
export function evaluateOperationalAlerts(options: {
  heartbeat?: {
    lastHeartbeatMs: number;
    connectionId: string;
  };
  commandEvents?: CommandMetricEvent[];
  operatingHours?: OperatingHours;
  currentMs?: number;
}): OperationalAlert[] {
  const currentMs = options.currentMs ?? Date.now();
  const operatingHours = options.operatingHours ?? DEFAULT_MYT_OPERATING_HOURS;
  const alerts: OperationalAlert[] = [];

  // 1. Heartbeat Freshness Alert (< 15 min in operating hours)
  if (options.heartbeat) {
    const { lastHeartbeatMs, connectionId } = options.heartbeat;
    if (isHeartbeatStale(lastHeartbeatMs, currentMs, operatingHours)) {
      const minutesStale = Math.round((currentMs - lastHeartbeatMs) / 60000);
      alerts.push({
        code: 'HEARTBEAT_STALE',
        severity: 'critical',
        message: `Connection '${connectionId}' has emitted no heartbeat for ${minutesStale}m during clinic operating hours.`,
        details: {
          connectionId,
          lastHeartbeatMs,
          minutesStale,
        },
        timestamp: new Date(currentMs).toISOString(),
      });
    }
  }

  // 2. Command Conflict Rate & Write Failure Rate Alerts
  if (options.commandEvents && options.commandEvents.length >= ALERT_THRESHOLDS.MIN_SAMPLE_SIZE_FOR_RATE_ALERTS) {
    const conflictRate = computeConflictRate(options.commandEvents);
    if (conflictRate > ALERT_THRESHOLDS.CONFLICT_RATE_PERCENT_THRESHOLD) {
      alerts.push({
        code: 'HIGH_CONFLICT_RATE',
        severity: 'warning',
        message: `Command conflict rate elevated at ${conflictRate.toFixed(2)}% (threshold: ${ALERT_THRESHOLDS.CONFLICT_RATE_PERCENT_THRESHOLD}%).`,
        details: {
          conflictRate,
          sampleSize: options.commandEvents.length,
          threshold: ALERT_THRESHOLDS.CONFLICT_RATE_PERCENT_THRESHOLD,
        },
        timestamp: new Date(currentMs).toISOString(),
      });
    }

    const writeFailureRate = computeWriteFailureRate(options.commandEvents);
    if (writeFailureRate > ALERT_THRESHOLDS.WRITE_FAILURE_RATE_PERCENT_THRESHOLD) {
      alerts.push({
        code: 'HIGH_WRITE_FAILURE_RATE',
        severity: 'critical',
        message: `Write verification failure rate critical at ${writeFailureRate.toFixed(2)}% (threshold: ${ALERT_THRESHOLDS.WRITE_FAILURE_RATE_PERCENT_THRESHOLD}%).`,
        details: {
          writeFailureRate,
          sampleSize: options.commandEvents.length,
          threshold: ALERT_THRESHOLDS.WRITE_FAILURE_RATE_PERCENT_THRESHOLD,
        },
        timestamp: new Date(currentMs).toISOString(),
      });
    }
  }

  return alerts;
}

export const TelemetryEventSchema = z.object({
  connectionId: z.string().min(1),
  metric: z.string().min(1),
  value: z.number(),
  labels: z.record(z.string()).default({}),
  timestamp: z.string().datetime(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
