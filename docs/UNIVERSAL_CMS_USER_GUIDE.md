# LamaniSync: Universal CMS Integration & User Navigation Guide

> **Audience**: Clinic Administrators, Healthcare Practitioners, Front-Desk Staff, and IT Integrators  
> **Applies to**: Any web-based Clinic Management System (Cloud SaaS, Local Web Server, SPA, or Server-Rendered Portal)

---

## 1. Overview: The Ambient CMS Bridge

LamaniSync connects your existing Clinic Management System (CMS) with **LamaniHub** without requiring complex server-side APIs, VPN tunnels, or custom database connectors.

```
┌────────────────────────────────────────────────────────┐
│                      Your Browser                      │
│                                                        │
│  ┌──────────────────────┐    ┌──────────────────────┐  │
│  │   Staff CMS Portal   │    │  LamaniSync Plugin   │  │
│  │ (Any Clinic Web CMS) │◄──►│ (In-browser Bridge)  │  │
│  └──────────────────────┘    └──────────┬───────────┘  │
└─────────────────────────────────────────┼──────────────┘
                                          │ Encrypted WebCrypto (Zero PHI)
                                          ▼
                               ┌──────────────────────┐
                               │   LamaniHub Cloud    │
                               │  (Sync Coordinator) │
                               └──────────────────────┘
```

### Core Operating Principles
- **Zero Double-Entry**: Appointments booked online via LamaniHub automatically sync into your CMS calendar.
- **Zero Credential Exfiltration**: LamaniSync **never** transmits CMS passwords, session cookies, or tokens to the cloud.
- **Exact-Origin Security**: Permissions are granted **strictly** to your clinic's exact web URL (never wildcard `*` permissions).
- **Read-After-Write Verification**: An appointment is only confirmed to the patient once LamaniSync reads back the confirmation directly from your CMS records.

---

## 2. Prerequisites

1. **Browser**: Google Chrome, Brave, Microsoft Edge, or any Chromium browser (Version 114+).
2. **Active Staff Session**: Your clinic CMS must be open and logged in on one browser tab.
3. **LamaniHub Pairing Code**: A one-time pairing code generated from your clinic's LamaniHub management dashboard.

---

## 3. Initial Setup & Pairing (One-Time)

Follow this universal sequence when configuring LamaniSync on any clinic workstation:

### Step 1: Open Your Clinic CMS
1. In your browser, navigate to your clinic's CMS URL (e.g., `https://app.lamanipulse.com`, `https://clinic.example.com`, or `http://192.168.1.50:8080`).
2. Log in with your standard staff or doctor credentials.
3. Leave this tab open.

### Step 2: Open LamaniSync Extension
1. Click the **puzzle icon** (Extensions) in your browser toolbar.
2. Pin **LamaniSync** to your toolbar for easy access.
3. Click the **LamaniSync** icon to open the popup.

### Step 3: Enter Pairing Code
1. Retrieve your pairing code from **LamaniHub** (`Settings → Integrations → LamaniSync → Generate Pairing Code`).  
   *(In local development / mock mode, enter `PULSE` or your test code).*
2. Enter the code into the pairing input box.
3. Click **Pair Device**.
   - *Under the hood*: LamaniSync generates a hardware-backed cryptographic ECDSA key in your browser and links your workstation to your clinic profile.

### Step 4: Grant CMS Origin Access
1. The popup will display **CMS Access Required** along with your **Target Clinic CMS URL**.
2. Click **Grant CMS Access**.
3. A browser security prompt will appear asking:  
   `"LamaniSync wants to access <your-exact-cms-url>"`.
4. Click **Allow**.

### Step 5: Complete Bridge Probe
1. LamaniSync automatically runs a 3-point compatibility check:
   - **CMS Route & Version Check**: Confirms standard CMS endpoints respond.
   - **Tenant Isolation Validation**: Verifies that your logged-in branch matches your LamaniHub clinic account.
   - **Capability Matrix Probe**: Tests read/write permissions for patients, appointments, and roster data.
2. Click **Retry Probe** if prompted.
3. Once complete, the status badge transitions to **Connected / Active**.

---

## 4. Daily Operational Workflow for Clinic Staff

Once paired, staff do **not** need to interact with the extension during daily operations. LamaniSync operates ambiently in the background.

### Routine 1: Ambient Availability & Calendar Sync (Reads)
1. **Normal Staff Navigation**: Use your CMS as you normally do:
   - Opening the **Appointment Calendar** or **Roster**.
   - Searching or viewing **Patient Records**.
   - Updating doctor schedules or consultation hours.
2. **Automatic Synchronization**:
   - As your CMS loads calendar slots or patient profiles, LamaniSync's isolated observer captures the schedule changes.
   - It strips out non-essential data and relays clean availability to LamaniHub in real time.
   - Patients booking online immediately see updated, conflict-free open slots.

### Routine 2: Inbound Booking Execution (Writes)
1. When a patient books an appointment via LamaniHub (e.g., website widget, WhatsApp bot, or portal):
   - LamaniHub sends an encrypted command to the active workstation running the CMS.
   - LamaniSync executes the booking through the certified adapter recipe.
2. **Read-Back Confirmation**:
   - Before confirming to the patient, LamaniSync reads back the created record from your CMS to ensure no slot clash or validation error occurred.
   - If successful, the booking appears on your CMS appointment screen immediately.

### Routine 3: Multiple Workstations & Active Fencing
- If multiple receptionists have the CMS open simultaneously:
  - LamaniSync uses an automatic **Leader Lease**.
  - One workstation is designated the primary writer.
  - If that workstation is closed or goes to sleep, leadership transfers seamlessly to another open workstation within 30 seconds.

---

## 5. Understanding Status Badges & Indicators

Check the badge in the top-left of the LamaniSync popup:

| Status Badge | State Name | Meaning & Recommended Action |
|:---|:---|:---|
| 🟢 **Connected / Active** | `ACTIVE` | **Fully Operational**. Reads and writes are synchronizing normally. |
| 🟡 **Probing CMS Bridge** | `PROBING` | **Verifying Compatibility**. Click *Retry Probe* to finish activation. |
| 🟠 **Awaiting CMS Access** | `PAIRED_NO_PERMISSION` | **Permission Needed**. Click *Grant CMS Access* and allow browser prompt. |
| 🔴 **Re-Authentication Needed** | `REAUTH_REQUIRED` | **Staff Logged Out**. Your CMS login session expired. Log back into your CMS tab, then click *Retry*. |
| 🟡 **Degraded Access** | `DEGRADED` | **Partial Permissions**. Staff account lacks permission for certain sections (e.g., billing or roster). Verify role in CMS. |
| ⚪ **Unpaired** | `UNPAIRED` | **Not Connected**. Enter a pairing code from LamaniHub to connect. |

---

## 6. Troubleshooting Common Scenarios

### Scenario A: "Failed to fetch dynamically imported module" (SPA / React CMS)
- **Cause**: Dynamic JavaScript bundles desynchronized when permissions were granted or after a CMS software update.
- **Solution**:
  1. Go to your CMS tab.
  2. Press **Cmd + Shift + R** (Mac) or **Ctrl + F5** (Windows) to hard-refresh.
  3. Reopen the LamaniSync popup.

### Scenario B: "Awaiting Read / Freshness Warning"
- **Cause**: The CMS tab has been idle for several hours without calendar activity.
- **Solution**:
  1. Click on your CMS tab.
  2. Switch between **Appointments** or **Patients** views.
  3. The observer will detect the query and refresh the connection timestamp immediately.

### Scenario C: "Tenant Mismatch" Error
- **Cause**: The staff member is logged into a different clinic branch than the one paired in LamaniHub.
- **Solution**:
  1. Verify the branch selected in your CMS.
  2. If switching branches, click **Unpair Device** in the LamaniSync popup and re-pair with the code for that branch.

### Scenario D: Reporting an Issue (Diagnostics Bundle)
If technical support requests diagnostic logs:
1. Click the LamaniSync icon.
2. Click **Diagnostics** in the top-right corner.
3. Review the diagnostic bundle: **zero patient names, IC numbers, or CMS passwords** are included (strict privacy compliance).
4. Click **Copy Diagnostic** and send the JSON text to support.

---

## 7. Security & Compliance Summary

| Requirement | How LamaniSync Enforces It |
|:---|:---|
| **Privacy / Non-Exfiltration** | No passwords, tokens, or raw cookies ever leave your computer. |
| **No Local PHI Storage** | Patient health data is never written to permanent disk storage (`chrome.storage.local`). |
| **Tamper-Proof Adapters** | CMS workflows are cryptographically signed using Ed25519 digital signatures. Arbitrary remote code is rejected. |
| **Fail-Closed Architecture** | If the CMS session expires or the internet drops, LamaniSync stops processing commands safely without data corruption. |
