# LamaniSync — Production Monitoring & Alerting Guide

This document defines operational metrics, alerting thresholds, PromQL queries, and Supabase SQL monitoring for the LamaniSync Chrome Extension ecosystem in production.

---

## 1. Core Principles & Privacy Boundary

In accordance with **AGENTS.md Rules 4, 5, and 6**:
- **Zero Raw PHI in Telemetry**: No Malaysian NRIC, phone numbers, patient names, clinical notes, or addresses may ever be emitted to logging pipelines or dashboards.
- **Correlation IDs**: All telemetry events carry opaque `correlationId` (UUIDv4) and `connectionId` identifiers for trace aggregation without exposing patient identities.
- **Zero Secret Transmission**: CMS session cookies, passwords, and tokens are never observed or exported in telemetry payloads.

---

## 2. Metric Catalog & Service Level Objectives (SLOs)

| Metric | Prometheus Name | Description | Target / Threshold | Severity |
| :--- | :--- | :--- | :--- | :--- |
| **Heartbeat Freshness** | `lsync_heartbeat_age_seconds` | Seconds since last heartbeat ping from active extension instance | `< 900s` (15m) during operating hours (08:00–22:00 MYT) | Critical |
| **Write Conflict Rate** | `lsync_command_conflict_rate` | Percentage of write commands resulting in slot/resource conflict | `< 2.0%` over 15m sliding window | Warning |
| **Write Failure Rate** | `lsync_write_verification_failure_rate` | Percentage of write commands failing read-after-write verification | `< 0.5%` over 15m sliding window | Critical |
| **Schema Drift Events** | `lsync_schema_drift_total` | Total count of DOM/API unparseable schema drift detections | `0` unexpected drifts per hour | Critical |
| **Session Drop-Offs** | `lsync_reauth_required_total` | Count of clinic staff session expirations (HTTP 401/403) | Baseline tracking | Warning if spike > 5x |
| **Lease Contention** | `lsync_lease_contention_total` | Count of failed lease acquisition attempts across clinic tabs | `< 5%` of lease requests | Warning |
| **Token Expiry Proximity** | `lsync_token_ttl_seconds` | Remaining validity of LamaniHub device session token | `> 3600s` (proactive renewal at 80% TTL) | Critical if `< 600s` |

---

## 3. Alert Rules (PromQL)

```yaml
groups:
  - name: lsync_production_alerts
    rules:
      # Alert: Stale Heartbeat during operating hours (08:00 - 22:00 MYT / UTC+8)
      - alert: LamaniSyncHeartbeatStale
        expr: >
          (time() - lsync_last_heartbeat_timestamp{state="ACTIVE"}) > 900
          and ((hour() + 8) % 24 >= 8 and (hour() + 8) % 24 < 22)
        for: 5m
        labels:
          severity: critical
          team: ops
        annotations:
          summary: "Clinic connection silent for > 15 minutes during operating hours"
          description: "Connection {{ $labels.connection_id }} for clinic {{ $labels.clinic_id }} has not sent a heartbeat for > 15 minutes."

      # Alert: High Command Conflict Rate (> 2% over 15 min)
      - alert: LamaniSyncHighConflictRate
        expr: >
          (sum(rate(lsync_commands_total{outcome="conflict"}[15m]))
            / sum(rate(lsync_commands_total[15m]))) * 100 > 2.0
          and sum(rate(lsync_commands_total[15m])) * 900 >= 10
        for: 5m
        labels:
          severity: warning
          team: sync-engine
        annotations:
          summary: "Elevated appointment booking conflict rate"
          description: "Conflict rate is {{ $value | printf \"%.2f\" }}% over the last 15 minutes (threshold: 2.0%)."

      # Alert: Critical Write Verification Failure Rate (> 0.5% over 15 min)
      - alert: LamaniSyncCriticalWriteFailureRate
        expr: >
          (sum(rate(lsync_commands_total{outcome="verification_failure"}[15m]))
            / sum(rate(lsync_commands_total[15m]))) * 100 > 0.5
          and sum(rate(lsync_commands_total[15m])) * 900 >= 10
        for: 2m
        labels:
          severity: critical
          team: sync-engine
        annotations:
          summary: "Write verification failure rate breached safe threshold"
          description: "Write verification failure rate is {{ $value | printf \"%.2f\" }}% (threshold: 0.5%). Potential CMS schema drift or race condition."

      # Alert: Active Schema Drift Detected
      - alert: LamaniSyncSchemaDriftDetected
        expr: increase(lsync_schema_drift_total[15m]) > 0
        for: 1m
        labels:
          severity: critical
          team: adapters
        annotations:
          summary: "CMS adapter schema drift detected"
          description: "Adapter {{ $labels.adapter_id }} detected schema mutations on CMS {{ $labels.target_origin }}."
```

---

## 4. Supabase SQL Monitoring Queries

### 4.1 Stale Connection Inspector (Clinic Operating Hours)
```sql
SELECT
  connection_id,
  clinic_id,
  target_origin,
  state,
  last_heartbeat_at,
  ROUND(EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at)) / 60) AS minutes_silent
FROM sync_connections
WHERE state = 'ACTIVE'
  -- Malaysia Time: 08:00 to 22:00
  AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') BETWEEN 8 AND 21
  AND last_heartbeat_at < NOW() - INTERVAL '15 minutes'
ORDER BY last_heartbeat_at ASC;
```

### 4.2 Rolling 15-Minute Conflict & Error Rates
```sql
WITH stats AS (
  SELECT
    count(*) AS total_cmds,
    count(*) FILTER (WHERE outcome = 'conflict') AS conflict_cmds,
    count(*) FILTER (WHERE outcome = 'verification_failure') AS write_failure_cmds,
    count(*) FILTER (WHERE outcome = 'terminal_failure') AS terminal_cmds
  FROM sync_command_audit
  WHERE created_at >= NOW() - INTERVAL '15 minutes'
)
SELECT
  total_cmds,
  conflict_cmds,
  write_failure_cmds,
  terminal_cmds,
  ROUND(100.0 * conflict_cmds / NULLIF(total_cmds, 0), 2) AS conflict_rate_pct,
  ROUND(100.0 * write_failure_cmds / NULLIF(total_cmds, 0), 2) AS write_failure_rate_pct
FROM stats;
```

### 4.3 Redacted Diagnostic Error Feed
```sql
SELECT
  id,
  connection_id,
  correlation_id,
  error_type,
  redacted_details,
  received_at
FROM sync_diagnostics
WHERE received_at >= NOW() - INTERVAL '1 hour'
ORDER BY received_at DESC
LIMIT 50;
```

---

## 5. Escalation & On-Call Matrix

| Severity | Response SLA | Channels | Primary Responder | Secondary Responder |
| :--- | :--- | :--- | :--- | :--- |
| **Critical** (P1) | `< 15 minutes` | PagerDuty + Voice + `#incidents` | Primary On-Call Engineer | Engineering Lead |
| **High** (P2) | `< 30 minutes` | PagerDuty + `#incidents` | Primary On-Call Engineer | Integration Specialist |
| **Warning** (P3) | `< 2 hours` | Slack `#lamanisync-alerts` | Daytime On-Call | Support Team |
| **Info** (P4) | Next Business Day | Slack `#lamanisync-metrics` | Dev Team | - |
