# Chrome Web Store Metadata, Disclosures & Release Documentation

**Extension Title**: LamaniSync  
**Development Identifier**: LamaniSync Dev  
**Manifest Version**: 3  
**Target Category**: Productivity / Workflow & Planning  
**Primary Language**: English  
**Support Contact**: compliance@lamanify.com / support@lamanify.com  
**Privacy Policy URL**: https://lamanify.com/privacy-policy  

---

## 1. Store Metadata & Single Purpose Declaration

### Single Purpose Statement
LamaniSync serves a single, well-defined operational purpose: **to provide a secure, authenticated synchronization bridge between certified cloud Clinic Management Systems (CMS) and the LamaniHub operational platform.**

### Short Description (Chrome Web Store Listing — max 132 chars)
Secure operational synchronization bridge between certified cloud clinic management systems (CMS) and LamaniHub.

### Detailed Store Description
LamaniSync connects authorized healthcare clinic staff workstations running certified cloud-based Clinic Management Systems (CMS) directly with their organization's LamaniHub operational dashboard.

Designed specifically for healthcare practices and clinical workflows, LamaniSync operates under strict security and zero-knowledge privacy boundaries:
- **Zero Raw PHI Storage or Transmission**: Patient health records, identification numbers, and contact details remain strictly contained within the clinic's authenticated CMS session. Only anonymized operational synchronization events (e.g. schedule slot availability, anonymized appointment identifiers, confirmation receipts) are communicated.
- **Hardware-Backed Device Authentication**: Every workstation generates a local WebCrypto keypair upon installation, requiring explicit administrator pairing before any sync operations can begin.
- **Exact-Origin CMS Binding**: Access is restricted strictly to the clinic's exact certified CMS domain. Wildcard permissions (`*://*/*`) are rejected at the architectural level.
- **Ephemeral & Battery-Efficient**: Built entirely on Chrome Extension Manifest V3 with an event-driven background service worker, automatic leader-lease coordination across tabs, and zero persistent background overhead.

---

## 2. Permission Justifications Matrix

Every permission requested by LamaniSync is strictly necessary to fulfill its single purpose. The extension adheres to the principle of least privilege.

| Permission / API | Scope | Necessity & Justification |
| :--- | :--- | :--- |
| **`storage`** | Local extension storage | Required to persist non-PHI workstation pairing state (`installationId`, `clinicId`, `connectionId`, `targetOrigin`, and ephemeral LamaniHub `sessionToken`) across service worker suspensions and browser restarts. **Boundary**: Never used to store CMS passwords, session cookies, bearer tokens, or raw Patient Health Information (AGENTS.md Rules 4 & 6). |
| **`alarms`** | Internal event scheduler | Required to schedule low-frequency background wakeups for leader lease heartbeats (preventing split-brain execution across multiple open tabs), periodic event count reconciliation, and exponential retry backoff. **Boundary**: Used strictly for internal timer scheduling. Transmits no data and touches no host origins. |
| **`declarativeNetRequest`** | Network response header normalization | Required to normalize upstream proxy duplicate CORS headers (`Access-Control-Allow-Origin: <origin>, *`) returned by Cloudflare / OpenNext for canonical Sync API endpoints (`https://app.lamanihub.com/v1/sync/*`), preventing browser-level CORS parse failures. **Boundary**: Strictly scoped to `https://app.lamanihub.com/v1/sync/*` and response header normalization only. Never reads, modifies, or inspects request bodies or patient data. |
| **`scripting`** | Dynamic content script registration | Required to dynamically inject safe observation and action runner scripts exclusively into the tab matching the exact paired CMS origin via `chrome.scripting.registerContentScripts`. **Boundary**: Scripts are never declared statically with broad wildcards (`<all_urls>`). If permissions are revoked or the device is unpaired, dynamic scripts are immediately unregistered. Zero arbitrary remote code execution (AGENTS.md Rules 2 & 3). |
| **`host_permissions`**<br>`https://app.lamanihub.com/*` | Background Sync Gateway Endpoint | Required for the background service worker to communicate with the LamaniHub synchronization and command gateway API (POST /v1/sync/installations/pair, leases, outbox polling). **Boundary**: Strictly restricted to the canonical LamaniHub synchronization host. Never accesses or transmits patient health records, credentials, or cookies (AGENTS.md Rules 3, 4, 13). |
| **`optional_host_permissions`**<br>`http://localhost:4001/*`<br>`https://app.lamanipulse.com/*`<br>`https://vxnvdmepejjhvphqxopl.supabase.co/*`<br>`https://*/*` | Runtime user-granted CMS origin | Allows the extension to dynamically request access to **only the exact CMS origin** utilized by the pairing clinic (e.g. `https://app.lamanipulse.com/*` and its Supabase database origin `https://vxnvdmepejjhvphqxopl.supabase.co/*`) via `chrome.permissions.request()`. **Boundary**: Prompts are triggered solely by explicit user interaction ("Grant CMS Access" button in popup). Broad wildcards are rejected at runtime. Permissions are immediately revoked upon unpairing. |
| **`chrome.permissions` API** | Intrinsic browser API | Used to query (`contains`), request (`request`), and revoke (`remove`) host permissions dynamically. Not declared in `permissions: []` to comply with Manifest V3 schema rules. |

---

## 3. Privacy Practices, Health Data Disclosures & Zero-Knowledge PHI

### Health & Sensitive Data Handling (AGENTS.md Rules 4, 5, 6)
LamaniSync is engineered from the ground up for compliance with healthcare data protection standards (including HIPAA and Malaysian Personal Data Protection Act / PDPA):

1. **Zero-Knowledge Architecture**:
   - The extension operates in the context of an already authenticated clinic staff session in the cloud CMS.
   - The extension **never** extracts, inspects, transmits, or stores Patient Health Information (PHI) such as patient names, identification numbers (NRIC/Passport), phone numbers, home addresses, or diagnostic/medical histories.
   - Only operational metadata necessary for synchronization is processed: deterministic appointment UUIDs, schedule timestamps, slot duration, and status indicators (confirmed, arrived, completed).
2. **No Credential Exfiltration**:
   - CMS passwords, session cookies, bearer tokens, and CSRF secrets are never accessed, copied, or transmitted to LamaniHub or any external server (AGENTS.md Rule 4).
   - Network interactions with the CMS rely entirely on the staff user's existing, ambient browser session.
3. **No Third-Party Trackers or Analytics**:
   - Zero analytics SDKs (no Google Analytics, Mixpanel, Segment, etc.).
   - Zero advertising networks, tracking pixels, or data brokering.
   - Zero external font, stylesheet, or script CDNs loaded at runtime.
4. **Data Transmission Boundary**:
   - Synchronization events flow strictly between the paired clinic CMS origin and the clinic's dedicated LamaniHub tenant API endpoint.
   - All network traffic is strictly encrypted via TLS (HTTPS / WSS).

---

## 4. Remote Code Declaration (Manifest V3 Compliance)

In strict compliance with Chrome Web Store policy and AGENTS.md Rule 2:

- **Zero Remote JavaScript**: The extension does not use `eval()`, `new Function()`, `setTimeout([string])`, remote `import()`, or dynamically injected `<script>` tags pointing to remote URLs.
- **Declarative Signed Adapter Manifests**:
  - CMS adapters are distributed as declarative JSON documents (`acme-cloud.manifest.json`, `vendor-cms-1.manifest.json`).
  - Manifests contain **only declarative data structures**: CSS selectors, JSON field paths, and predefined action enumerations.
  - Manifests are digitally signed using Ed25519 cryptographic signatures verified against hardcoded vendor public keys before parsing.
  - Parsing and execution are performed exclusively by a bounded, pre-packaged interpreter compiled directly into the extension bundle.
  - Any tampered or unsigned manifest fails verification immediately and rolls back safely to the bundled Last-Known-Good configuration.

---

## 5. Dependencies Justification Matrix (AGENTS.md Rule 13)

### Runtime Dependencies (`dependencies`)

#### `zod` (v3.24.2)
- **Why it is needed**: Strict runtime schema validation across all communication channels: inter-world postMessage payloads, background service worker messages, signed adapter manifest JSON structures, and storage keys (enforcing AGENTS.md Rule 9).
- **Security & Privacy Boundary**: Operates entirely in-memory with zero external network access. Does not log, serialize, or transmit validated payloads.

#### `react` (v19.0.0) & `react-dom` (v19.0.0)
- **Why it is needed**: Component framework for rendering the extension popup interface (onboarding wizard, connection state indicators, paired origin status, and user-initiated diagnostics modal).
- **Security & Privacy Boundary**: Bundled into isolated popup HTML context (`popup.html`). Operates only when popup is opened by user. Zero execution in background service worker or page world.

### Development & Build Tooling (`devDependencies`)

#### `@playwright/test` (v1.63.0)
- **Why it is needed**: Development-only test runner used to automate end-to-end browser scenarios (`playwright.config.ts`, `tests/e2e/`) in headless Chromium.
- **Distribution Boundary**: Excluded completely from production bundles; zero footprint in release ZIP.

#### `@crxjs/vite-plugin` (v2.7.1) & `vite` (v6.2.0)
- **Why it is needed**: Build tooling to compile TypeScript, bundle React popup UI, and package Manifest V3 assets into `dist/`.
- **Distribution Boundary**: Runs strictly at build time. No development server or HMR code is included in production artifacts.

---

## 6. Dashboard Submission, Private Beta & Rollback Procedures

### A. Pre-Submission Package Validation
Before uploading to the Chrome Developer Dashboard, run the deterministic packaging suite:
```bash
npm run package
```
This executes:
1. Full TypeScript typecheck and clean production Vite/CRXJS build.
2. Integrity validation: confirms presence of all icons (16, 32, 48, 128), `manifest.json`, popup HTML, and dynamic runner scripts.
3. Boundary enforcement: asserts zero test files, mocks, `.map` files, or `.env` secrets exist in `dist/`.
4. Deterministic ZIP packaging in `release/lamanisync-extension-v{version}.zip`.
5. Cryptographic SHA-256 generation recorded in `release/lamanisync-extension-v{version}.zip.sha256`.

### B. Chrome Developer Dashboard Submission Flow
1. **Account**: Sign in to the official verified Lamanify Google Developer Account.
2. **Package Upload**:
   - Navigate to the LamaniSync extension item.
   - Upload the generated `release/lamanisync-extension-v{version}.zip`.
   - Verify that the dashboard computes the matching package size and recognizes Manifest V3 without warnings.
3. **Store Listing**:
   - Enter Title: `LamaniSync`.
   - Paste Short and Detailed Descriptions from Section 1 above.
   - Upload official icons (`public/icons/icon-128.png`) and standard UI screenshots (1280x800) demonstrating device pairing and status indicators.
4. **Privacy Tab**:
   - Single Purpose: Paste the Single Purpose Statement from Section 1.
   - Permission Justifications: Copy the exact justifications from Section 2 for `storage`, `alarms`, and `scripting`.
   - Host Permissions: Specify that host access is requested dynamically at runtime for certified clinic domains.
   - User Data Disclosures: Check "Zero sensitive personal data collected or stored". Check "Authentication information used strictly for internal sync". Confirm no data is sold or used for credit scoring/advertising.
5. **Distribution & Visibility (Private Beta)**:
   - In Phase 13, set visibility to **Private** / **Restricted Distribution**.
   - Restrict access to designated tester Google Groups / allowed email list (clinical pilot partners).
   - Save and submit for automated and manual review.

### C. Rollback & Emergency Incident Procedures
1. **Version Immutability**: Every release ZIP and SHA-256 checksum is permanently archived in tagged Git releases and build artifacts.
2. **Dashboard Staged Rollback**:
   - If an unexpected regression occurs in the field, maintain the previously certified release ZIP (`release/lamanisync-extension-v{prev}.zip`).
   - Immediately upload the previous build with an incremented patch version to the Developer Dashboard.
3. **Runtime Kill-Switch**:
   - In addition to Web Store rollbacks, LamaniSync includes a built-in cryptographic kill-switch endpoint polled during session establishment. If an adapter or origin is flagged, the extension automatically halts background execution and notifies the user via the popup UI.
