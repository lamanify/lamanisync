# LamaniSync — Emergency Incident Response Runbook

This runbook defines standard operating procedures (SOPs) for responding to high-severity synchronization failures, security events, and CMS schema drifts in production.

---

## 1. Six-Step Incident Response Standard Operating Procedure

When a P1/P2 alert fires or sync anomalies are reported, execute the following 6 steps in strict sequence:

```plain text
[Step 1: PAUSE]  ──>  [Step 2: PRESERVE]  ──>  [Step 3: ROLLBACK / PIN]
       │
       ▼
[Step 4: RECONCILE] ──> [Step 5: COMMUNICATE] ──> [Step 6: POST-MORTEM & TEST]
```

### Step 1: PAUSE (Halt Unsafe Activity)
Immediately prevent unsafe writes or cascading errors using the **Three-Tier Kill-Switch Framework**:

1. **Global Kill-Switch** (Universal halt across all clinics):
   ```bash
   # Emergency halt all extension writes globally via LamaniHub Admin Console / CLI:
   curl -X POST "https://sync.lamanify.com/api/v1/admin/kill-switch" \
     -H "Authorization: Bearer $LAMANI_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"level": "global", "reason": "Incident INC-20260921: Critical write failure surge", "paused": true}'
   ```
2. **Adapter-Level Kill-Switch** (Halt specific CMS vendor):
   ```bash
   curl -X POST "https://sync.lamanify.com/api/v1/admin/kill-switch" \
     -H "Authorization: Bearer $LAMANI_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"level": "adapter", "targetId": "vendor-cms-1", "reason": "Vendor CMS 1 schema drift detected", "paused": true}'
   ```
3. **Connection-Level Kill-Switch** (Pause single clinic workstation):
   ```bash
   curl -X POST "https://sync.lamanify.com/api/v1/admin/kill-switch" \
     -H "Authorization: Bearer $LAMANI_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"level": "connection", "targetId": "conn_prod_clinic_101", "reason": "High conflict rate on terminal", "paused": true}'
   ```
*Expected Result*: Active extensions transition `ConnectionFSM` to `PAUSED` within 30 seconds upon next poll or message.

---

### Step 2: PRESERVE (Capture Redacted Diagnostics)
Preserve execution traces for root-cause analysis without violating patient privacy (AGENTS.md Rule 6):

1. Query Supabase for recent redacted diagnostic logs:
   ```sql
   SELECT correlation_id, error_type, redacted_details, received_at
   FROM sync_diagnostics
   WHERE received_at >= NOW() - INTERVAL '30 minutes'
   ORDER BY received_at DESC;
   ```
2. Export extension diagnostic snapshot from user popup or admin console:
   - Contains: Extension version, CMS URL (origin only), Connection State, Last Heartbeat, Redacted Error Stack.
   - Strictly contains **no NRIC, phone numbers, patient names, or raw session cookies**.

---

### Step 3: ROLLBACK / PIN (Restore Last-Known-Good)
If the incident was caused by an adapter release, uncertified CMS update, or bad recipe:

1. **Pin Adapter to Last-Known-Good (LKG)**:
   ```bash
   curl -X POST "https://sync.lamanify.com/api/v1/admin/adapters/vendor-cms-1/pin" \
     -H "Authorization: Bearer $LAMANI_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"version": "1.0.0", "reason": "Rollback from faulty v1.1.0 release"}'
   ```
2. The extension's `ManifestLifecycleManager` will detect signature of candidate fails or pin mismatch, automatically activating `rollbackToLkg()`.
3. If CMS vendor deployed breaking UI changes, keep adapter paused until a patched and signed adapter manifest is deployed.

---

### Step 4: RECONCILE (Detect & Correct Missed Events)
Once the adapter or CMS connection is stabilized:

1. Resume the connection:
   ```bash
   curl -X POST "https://sync.lamanify.com/api/v1/admin/kill-switch" \
     -H "Authorization: Bearer $LAMANI_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"level": "adapter", "targetId": "vendor-cms-1", "paused": false}'
   ```
2. Trigger an immediate historical reconciliation sweep:
   - Runs `ReconciliationWorker.reconcileWindow(windowStart, windowEnd)` for the incident window.
   - Compares CMS appointment records with LamaniHub database.
   - Emits canonical `appointment_created` or `appointment_rescheduled` events for any changes made manually during the pause.

---

### Step 5: COMMUNICATE (Notify Stakeholders)
Adhere to the incident notification SLA:

1. **Within 15 minutes**: Post status update to clinic portal / status page:
   - "LamaniSync is temporarily paused for [CMS Vendor] due to routine synchronization maintenance. Clinic staff can continue normal CMS operations."
2. **Post-Resolution**: Send resolution notice with summary of reconciled records.

---

### Step 6: POST-MORTEM & AUTOMATED TEST
Every incident must produce an automated regression test and prevention action:

1. Author blameless post-mortem report in `docs/incidents/INC-YYYYMMDD.md`.
2. Replicate the failure mode in `test-harness/mock-cms/` or `tests/unit/`.
3. Add a dedicated regression test case verifying that the new error condition is cleanly handled, classified, or prevented.
4. Merge test and adapter fix with passing CI (`npm run test && npm run test:contract && npm run test:e2e`).

---

## 2. Playbooks for Common Production Incidents

### Scenario A: CMS Schema Drift
- **Symptom**: `lsync_schema_drift_total` increments; extraction returns empty patient or appointment lists.
- **Action**:
  1. Trigger Adapter Kill-Switch for affected vendor.
  2. Inspect CMS DOM mutations using mock CMS or test account in isolated staging environment.
  3. Update field extractors or selectors in adapter recipe.
  4. Increment adapter version, sign with offline Ed25519 root key (`npm run sign:manifest`).
  5. Deploy signed manifest to LamaniHub CDN.
  6. Lift adapter pause.

### Scenario B: CMS 5xx / 429 Rate Limit Storm
- **Symptom**: API requests to CMS fail with 429 Too Many Requests or 503 Service Unavailable.
- **Action**:
  1. Verify exponential backoff in service worker: polling intervals automatically back off from 30s to 60s, 120s, up to 300s.
  2. If CMS is hard-down, trigger Connection or Adapter Kill-Switch to cease load until vendor resolves downtime.
  3. Once CMS recovers, resume with staggered reconnection jitter.

### Scenario C: Write Verification Failure Storm (> 0.5%)
- **Symptom**: `lsync_write_verification_failure_rate` alert triggers.
- **Action**:
  1. Immediately trigger Global or Adapter Kill-Switch. Under AGENTS.md Rule 10, unverified writes must NEVER be confirmed.
  2. Check if clinic staff are concurrently double-booking the same slots.
  3. Inspect verification diffs in `RedactedDiagnostic` records.
  4. Fix recipe or concurrency locking before resuming writes.

### Scenario D: Compromised Device Token / Security Alert
- **Symptom**: Unauthorized token usage or workstation decommission.
- **Action**:
  1. Immediately revoke installation:
     ```bash
     curl -X POST "https://sync.lamanify.com/api/v1/sync/revoke" \
       -H "Authorization: Bearer $LAMANI_ADMIN_TOKEN" \
       -d '{"installationId": "inst_comp_999", "reason": "Workstation decommissioned"}'
     ```
  2. Extension receives 401/403 with `REVOKED`, transitions FSM to `REVOKED`, and wipes local session keys.
