# LamaniSync Chrome Extension — Comprehensive Threat Model

**Version:** 1.0.0  
**Phase:** 11 (Testing Matrix & Continuous Integration)  
**Governing Rules:** `AGENTS.md` Rules 1–14  
**Last Updated:** 2026-09-21  

---

## 1. Executive Summary & Architecture Overview

LamaniSync is a secure, high-integrity Chrome Extension built exclusively on **Manifest V3**. It serves as an automated clinical synchronization bridge connecting staff-authenticated cloud Clinic Management Systems (CMS) with the LamaniHub platform. Because it operates within medical environments handling Patient Health Information (PHI) and clinical bookings, LamaniSync is engineered under a **zero-trust, fail-closed** paradigm.

### The 5 Architectural Tiers

```
+-----------------------------------------------------------------------------------+
| Tier 1: Cloud CMS & Page-World DOM                                                |
|   - Authenticated clinic staff web session (cookies, DOM elements, API routes)    |
|   - Main-World Runner (`page-world.ts`) executing ONLY allowlisted action IDs     |
+-----------------------------------------------------------------------------------+
                                      ▲
                                      │ Secure CustomEvent / postMessage Bridge
                                      │ (One-Time Random Handshake Token)
                                      ▼
+-----------------------------------------------------------------------------------+
| Tier 2: Content Script Isolation Boundary                                         |
|   - Isolated World Content Script (`content-script.ts`)                           |
|   - Runtime Message Validator (`page-message-validator.ts`)                       |
|   - Dynamic exact-origin script registration (`registration.ts`)                  |
+-----------------------------------------------------------------------------------+
                                      ▲
                                      │ chrome.runtime.sendMessage (Internal Chrome IPC)
                                      ▼
+-----------------------------------------------------------------------------------+
| Tier 3: Extension Background Service Worker                                       |
|   - Ephemeral Service Worker (`service-worker.ts`)                                |
|   - Connection FSM (`connection-fsm.ts`) & Command FSM (`command-fsm.ts`)         |
|   - Pairing Coordinator, Outbox Poller, Command Executor, Lease Client            |
|   - Token Manager, Echo Suppressor, Diagnostic Redactor, Update Manager           |
+-----------------------------------------------------------------------------------+
                                      ▲
                                      │ Local Isolated Web APIs
                                      ▼
+-----------------------------------------------------------------------------------+
| Tier 4: Storage & Device Key Isolation                                            |
|   - Non-exportable WebCrypto ECDSA/Ed25519 Private Key in IndexedDB               |
|   - Ephemeral metadata & token storage in `chrome.storage.local` (ZERO PHI)       |
+-----------------------------------------------------------------------------------+
                                      ▲
                                      │ TLS 1.3 HTTPS / WSS Mutual Verification
                                      │ Signed Requests, Monotonic Fencing Tokens
                                      ▼
+-----------------------------------------------------------------------------------+
| Tier 5: LamaniHub Cloud Infrastructure                                            |
|   - Staging & Production Sync APIs                                                |
|   - Fenced Leader Lease Distributor, Outbox Command Queue, Remote Kill-Switches   |
+-----------------------------------------------------------------------------------+
```

---

## 2. Trust Boundaries & Threat Actors

| Threat Actor | Description | Capabilities & Attack Vectors | Mitigations |
| :--- | :--- | :--- | :--- |
| **Malicious Page Script (XSS)** | Malicious script injected into CMS page via third-party library, tag manager, or stored XSS. | Prototype pollution, overriding `window.fetch`/`XMLHttpRequest`, reading page DOM, eavesdropping on `window.postMessage`. | Isolated World boundary, random 256-bit cryptographically secure handshake token, strictly allowlisted action IDs (Rule 8), zero arbitrary code evaluation (Rule 2). |
| **Malicious Extension** | Other rogue extensions installed in the user's browser. | Attempting to access extension storage or broadcast messages to background. | Chrome extension sandbox prevents cross-extension access to `chrome.storage.local` and IndexedDB. Background listeners accept messages only from extension's own sender ID. |
| **Network Adversary (MITM)** | Active or passive eavesdropper on the network path. | Traffic interception, replay of previous write requests, tampering with payload. | TLS 1.3 encryption, dual-nonce replay protection (`X-Lamani-Nonce`, `X-Lamani-Timestamp`), signed payloads, short-lived session tokens. |
| **Compromised Backend / Rogue Hub** | Compromised cloud server or insider threat attempting to exploit extensions. | Serving malicious adapter recipes, pushing arbitrary API write payloads, denial of service. | Ed25519 signature verification on all adapter manifests (Rule 9), bounded recipe interpreter with zero `eval`, strict Zod schema validation, fail-closed rollback to Last-Known-Good. |
| **Workstation Multi-Tab Operator** | Clinic staff opening multiple CMS tabs simultaneously. | Split-brain race conditions, concurrent duplicate appointment bookings. | Distributed leader leases with monotonically increasing fencing tokens (Rule 7), mutual exclusion, deduplication cache. |

---

## 3. Permission Boundaries & Manifest V3 Enforcement

### 3.1 Strict Minimal Permissions
Under `manifest.config.ts`, only three browser permissions are declared:
1. `storage`: For storing ephemeral pairing connection metadata and short-lived tokens.
2. `scripting`: For dynamically registering content scripts matching exclusively the paired CMS origin.
3. `alarms`: For scheduling service worker wakeups (lease renewal, token rotation, reconciliation).

### 3.2 Exact Origin Host Permissions (Rule 3)
- **Zero Static Wildcards**: `manifest.json` declares **zero** static host permissions.
- **Dynamic Scoping**: Runtime host permission is requested via `chrome.permissions.request()` only after the clinic pairing handshake completes.
- **Strict Validation**: The origin is normalized and validated against `normalizeExactOrigin` (rejecting any wildcard `*`, path components, or non-HTTP/HTTPS protocols).
- **Explicit User Gesture**: Permission prompt is triggered exclusively by explicit staff interaction in the popup UI.
- **Clean Revocation**: When the device is unpaired or revoked, host permissions and registered content scripts are instantly purged.

---

## 4. Architectural Tier Details & Defenses

### Tier 1: Cloud CMS & Page-World DOM
- **Runner Sandboxing**: `src/page/page-world.ts` executes in the MAIN world to observe legitimate CMS requests using native page cookies.
- **Predefined Action IDs Only (Rule 8)**: The runner implements a closed `switch` statement for allowlisted actions (`ACTION_APPOINTMENT_CREATE`, `ACTION_APPOINTMENT_RESCHEDULE`, `ACTION_APPOINTMENT_CANCEL`, `ACTION_PATIENT_CREATE`). It **never** accepts arbitrary URLs, HTTP methods, or request bodies from external callers.
- **Prototype Tampering Defense**: Functions use bound references to native prototypes captured at initial execution.

### Tier 2: Content Script Isolation Boundary
- **Handshake Verification**: Communication between MAIN world and ISOLATED world requires a 256-bit cryptographic token (`crypto.getRandomValues`) established during initialization.
- **Origin Validation**: `src/content/page-message-validator.ts` verifies `event.origin` against the paired CMS origin and validates message structure via Zod before relaying to background.
- **Duplicate Prevention**: Re-initialization attempts with mismatched tokens are dropped and logged.

### Tier 3: Extension Background Service Worker
- **State Machine Enforcement**: All transitions are strictly governed by `ConnectionFSM` and `CommandFSM`. Invalid transitions throw `IllegalTransitionError` and fail closed.
- **Ephemeral SW Survival (Rule 7)**: The service worker does not rely on global memory variables. On wakeup, `ensureServiceWorkerRestored()` restores state from storage, revalidates active leases, and restarts poller and alarms.
- **Write-Loop Prevention**: `EchoSuppressor` maintains a sliding temporal window of writes executed by the extension. When the CMS page fires an observed read for an appointment created by the extension, the echo is suppressed, preventing infinite sync loops.

### Tier 4: Storage & Key Isolation (Rules 4, 5, 6)
- **WebCrypto Key Generation**: A non-extractable ECDSA (P-256) / Ed25519 key pair is generated inside the browser's native WebCrypto engine and stored in IndexedDB. Private key bytes can never be read or exported by JavaScript.
- **Zero Raw PHI in Storage**: `chrome.storage.local` is strictly audited to ensure no patient names, IC numbers, contact details, or clinical records are stored. Only metadata IDs, numeric cursors, and hashes are persisted.
- **Zero CMS Credential Transmission**: Staff passwords, session cookies, and bearer tokens from the CMS are never transmitted to LamaniHub or saved in extension storage.

### Tier 5: LamaniHub Cloud Infrastructure
- **Fenced Leader Leases**: Only the active lease holder can poll the outbox and execute write commands. Commands and leases carry fencing tokens that increment monotonically. Stale leases are rejected with 409 Conflict.
- **Read-After-Write Verification (Rule 10)**: An appointment is never confirmed or acknowledged upstream until the extension performs an independent read-back query against the CMS and verifies field diffs.
- **Multi-Scope Kill-Switches**: Remote pause signals can immediately halt operations at three granularities: global, per-adapter, or per-clinic connection.

---

## 5. Threat Mitigation Matrix

| Threat ID | Vulnerability / Attack | Architectural Tier | Severity | Implemented Mitigation |
| :--- | :--- | :--- | :--- | :--- |
| **TM-01** | Arbitrary Remote Code Execution | Tier 1 / Tier 3 | **Critical** | Zero `eval` or `new Function`. All execution logic is packaged locally. Manifest V3 CSP strictly enforced (Rule 2). |
| **TM-02** | Broad Host Permission Abuse | Tier 2 | **High** | Exact CMS origin matching only. Dynamic script registration unregisters scripts upon unpairing (Rule 3). |
| **TM-03** | Malicious Manifest Tampering | Tier 3 / Tier 5 | **Critical** | Ed25519 cryptographic signature verification over adapter manifests. Fails closed and rolls back to Last-Known-Good (Rule 9). |
| **TM-04** | PHI Leakage in Extension Storage | Tier 4 | **High** | `chrome.storage.local` restricted to connection metadata and cursors. Enforced by automated CI PHI scanner (Rule 6). |
| **TM-05** | CMS Credential Harvesting | Tier 1 / Tier 3 | **Critical** | Extension uses ambient browser cookie auth; passwords and session cookies are never extracted or sent to LamaniHub (Rule 4). |
| **TM-06** | Split-Brain Duplicate Bookings | Tier 3 / Tier 5 | **High** | Distributed leader leases with monotonic fencing tokens. Exactly one active leader per connection (Rule 7). |
| **TM-07** | Write Infinite Loop | Tier 1 / Tier 3 | **Medium** | Echo suppressor with bounded deduplication cache tags and suppresses reads of extension-authored records. |
| **TM-08** | Diagnostic Log PHI Leakage | Tier 3 / Tier 4 | **Medium** | Patronymic and international name redactor, NRIC/IC masker, credential sanitizer applied before logging or diagnostic export. |
| **TM-09** | Replay of Outbox Commands | Tier 3 / Tier 5 | **High** | Unique idempotency keys per command. CMS query performed before execution to verify non-existence. |
| **TM-10** | Service Worker Suspension Desync | Tier 3 | **High** | `ensureServiceWorkerRestored()` restores state machine, active lease, and token renewals on every wake-up alarm or message. |

---

## 6. Continuous Security Verification

The security posture defined in this threat model is automatically validated on every commit and pull request via the hardened CI pipeline (`.github/workflows/ci.yml`):
- **Automated PHI & Secret Scanner (`scripts/scan-phi.js`)**: Scans all source, test, script, and built distribution files for private keys, tokens, unredacted Malaysian ICs, and storage rule violations.
- **Capability Contract Tests (`tests/contract/`)**: Validates adapter behavior and ensures fail-closed rejection of tampered manifests.
- **15 E2E Scenarios (`tests/e2e/`)**: Exercises fail-safe handling of fault injection (401, 403, 409, 429, 500), kill-switch activation, session expiration, crash recovery, and update deferral.
