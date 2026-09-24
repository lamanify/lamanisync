export interface DocArticle {
  slug: string;
  title: string;
  description: string;
  category: string;
  categorySlug: string;
  order: number;
  readTime: string;
  lastUpdated: string;
  popular?: boolean;
  content: string;
}

export interface DocCategory {
  slug: string;
  title: string;
  description: string;
  icon: string;
  articles: DocArticle[];
}

export const docCategories: DocCategory[] = [
  {
    slug: 'getting-started',
    title: 'Getting Started',
    description: 'Essential guides to install the Chrome Extension, configure workstation pairing, and establish real-time synchronization.',
    icon: 'rocket',
    articles: [],
  },
  {
    slug: 'cms-connection-guides',
    title: 'CMS Connection Guides',
    description: 'Step-by-step setup guides for Dentrix Ascend, eClinicalWorks, LamaniPulse EHR, and custom clinic portals.',
    icon: 'server',
    articles: [],
  },
  {
    slug: 'clinic-operations',
    title: 'Clinic Operations & Deployment',
    description: 'Workstation redundancy, failover active leases, zero-inbound firewall topology, and clinic security.',
    icon: 'shield',
    articles: [],
  },
  {
    slug: 'troubleshooting-and-support',
    title: 'Troubleshooting & Support',
    description: 'Connection diagnostics, error codes, tab discarding resolutions, and staff FAQ.',
    icon: 'lifebuoy',
    articles: [],
  },
];

export const docArticles: DocArticle[] = [
  // 1. Getting Started: Installation Guide
  {
    slug: 'installation-guide',
    title: 'Installing LamaniSync: Complete Workstation Connection Guide',
    description: 'Comprehensive installation walkthrough for clinic workstations: Chrome Web Store setup, LamaniHub pairing tokens, WebCrypto Ed25519 handshakes, and active tunnel verification.',
    category: 'Getting Started',
    categorySlug: 'getting-started',
    order: 1,
    readTime: '6 min read',
    lastUpdated: 'September 2026',
    popular: true,
    content: `
## Overview

The **LamaniSync Workstation Synchronizer** connects your authenticated web-based Clinic Management System (CMS) to **LamaniHub** and **Sara AI WhatsApp Automation** in real-time.

Unlike legacy healthcare synchronizers that require intrusive Windows background services, database drivers, or open inbound firewall ports, LamaniSync executes as a secure **Manifest V3 Chrome Extension** directly within the front-desk browser user-space.

\`\`\`plain text
[Patient on WhatsApp] 
         │
         ▼
[Sara AI / LamaniHub Cloud] 
         │ (TLS 1.3 Outbound Encrypted Stream)
         ▼
[Front-Desk Workstation (LamaniSync Chrome MV3)]
         │ (In-Memory Page-World Bridge)
         ▼
[Authenticated CMS Tab (Dentrix / eCW / Pulse)]
         │
         ▼ (Readback Verification & SHA-256 Receipt)
[Instant Confirmation to Patient]
\`\`\`

---

## Prerequisites

Before beginning installation on a clinic workstation, ensure your setup meets these criteria:

| Requirement | Specification | Notes |
| :--- | :--- | :--- |
| **Operating System** | Windows 10/11, macOS 12+, or ChromeOS | Runs on any modern clinic PC |
| **Browser** | Google Chrome v116 or higher | Edge / Brave also supported (Chromium engine) |
| **CMS Session** | Active login session to your cloud CMS | Staff must be logged into the clinic portal |
| **LamaniHub Access** | Clinic Owner or Administrator role | Required to generate clinic pairing token |
| **Network** | Outbound HTTPS/WSS on port 443 | 0 inbound open ports required |

---

## Step 1: Install the Extension from Chrome Web Store

1. Open **Google Chrome** on the clinic workstation where staff manage appointments.
2. Navigate to the official extension listing on the **Chrome Web Store**:
   - Search for **"LamaniSync Bridge"** or use the direct installation link provided in your LamaniHub onboarding email.
3. Click the blue **Add to Chrome** button.
4. When prompted by Chrome permissions dialog, click **Add Extension**.
5. Pin the extension to your browser toolbar:
   - Click the **Extensions puzzle icon** in the top-right corner of Chrome.
   - Click the **Pin icon** next to **LamaniSync** so the badge is always visible to reception staff.

> **Security Note**: LamaniSync runs under Manifest V3 and requests zero broad host permissions by default. It operates with strictly declarative sandboxing and never loads external JavaScript.

---

## Step 2: Retrieve Your Clinic Pairing Token from LamaniHub

Each clinic location possesses a unique, cryptographically signed pairing token that authenticates the workstation to LamaniHub's synchronization pipeline.

1. In a separate tab, log into **LamaniHub** at [https://lamanihub.com/login](https://lamanihub.com/login).
2. Select your clinic location from the organization selector.
3. In the left navigation menu, go to **Settings → Integrations → LamaniSync Bridge**.
4. Click **Generate Workstation Pairing Token**.
5. Select the primary CMS adapter for this workstation (e.g., *Dentrix Ascend*, *eClinicalWorks*, or *LamaniPulse EHR*).
6. Click **Generate Token** and click the copy icon to copy the alphanumeric token:

\`\`\`plain text
LMN-SYNC-v1-98a2f1c84b7e09d3-550e8400-e29b-41d4-a716-446655440000
\`\`\`

> **Important**: Pairing tokens are one-time credentials with a 15-minute expiration window. If you do not pair the workstation within 15 minutes, generate a fresh token from the dashboard.

---

## Step 3: Perform the WebCrypto Ed25519 Handshake

1. On the clinic workstation, click the **LamaniSync extension icon** in the Chrome toolbar.
2. In the pairing input field, paste the **Pairing Token** copied from LamaniHub.
3. Click **Initiate Secure Pairing**.
4. The extension automatically generates a local **WebCrypto Ed25519 keypair** inside browser memory:
   - The private key remains locked inside your local workstation's secure storage.
   - The public key is transmitted to LamaniHub to establish mutual end-to-end cryptographic payload signing.
5. The extension status badge will switch from **Unpaired** to **Paired & Handshaking**.

---

## Step 4: Grant Exact-Origin Host Permission

To allow LamaniSync to bridge appointments with your CMS, Chrome requires an explicit origin grant for the specific website your clinic uses.

1. When prompted in the extension popup, click **Grant Origin Access**.
2. Select or verify the exact URL of your clinic's web portal (e.g., \`https://live.dentrixascend.com\` or \`https://clinicname.eclinicalweb.com\`).
3. Click **Allow**.

> **Zero Walled-Garden Access**: LamaniSync adheres strictly to Rule #3 of our Security Architecture: **Host permissions are never broader than the exact paired CMS origin.** The extension will never have access to your personal browsing, email, or other open tabs.

---

## Step 5: Verify Active Tunnel Status

Once origin permissions are granted and the authenticated CMS tab is open:

1. Open your clinic CMS in an active Chrome tab and log in as normal.
2. Click the **LamaniSync extension badge**.
3. Confirm that all three status indicators are green:
   - **Tunnel State**: \`Active Bridge (Connected)\`
   - **Lease Role**: \`Primary Active Leader (15s Heartbeat)\`
   - **CMS Session**: \`Authenticated (Ready for Slot Reads & Booking)\`
4. The extension icon in your Chrome toolbar will display a green checkmark dot indicating synchronization readiness.

---

## Step 6: Test Real-Time Slot Ingestion & Writeback

To verify end-to-end functionality without affecting real patient schedules:

1. In the **LamaniHub Dashboard**, go to **Integrations → LamaniSync Bridge → Test Dispatch**.
2. Click **Run Diagnostic Ping**.
3. LamaniHub will transmit an encrypted read request to the workstation.
4. Observe the LamaniSync popup: the diagnostic counter will increment, showing:
   - **Round-Trip Handshake Latency**: Typically 120ms–350ms.
   - **Readback Verification**: State hash confirmed.
   - **Active Write Capability**: Verified.

Your workstation is now fully operational. Appointments booked via Sara AI on WhatsApp will now synchronize automatically into your clinic calendar.
    `,
  },

  // 2. Getting Started: Quickstart LamaniHub
  {
    slug: 'quickstart-lamanihub',
    title: 'LamaniHub Dashboard Pairing & Token Generation',
    description: 'Manage clinic locations, generate 15-minute rotating pairing tokens, configure staff workstation permissions, and monitor active leases.',
    category: 'Getting Started',
    categorySlug: 'getting-started',
    order: 2,
    readTime: '4 min read',
    lastUpdated: 'September 2026',
    popular: false,
    content: `
## The LamaniHub Bridge Console

The **LamaniHub Integrations Console** provides centralized oversight of all front-desk workstations deployed across your clinic branches. From this dashboard, administrators can generate pairing tokens, inspect live WebSocket heartbeats, revoke lost devices, and configure active lease parameters.

\`\`\`plain text
LamaniHub Cloud Dashboard
  └── Organizations & Branches
        └── Branch: Downtown Dental Center
              ├── Workstation #1 (Front Desk Left)  ── [Active Leader]
              ├── Workstation #2 (Front Desk Right) ── [Warm Standby]
              └── Workstation #3 (Back Office)      ── [Warm Standby]
\`\`\`

---

## Role & Permission Requirements

Only authorized clinic personnel can generate synchronizer pairing tokens:

| User Role | Token Generation | Device Revocation | View Sync Logs |
| :--- | :--- | :--- | :--- |
| **Practice Owner** | Yes (Full access) | Yes | Yes |
| **Clinic Administrator** | Yes (Assigned branches) | Yes | Yes |
| **Front-Desk Staff** | No (View only) | No | Yes (Status only) |
| **Doctor / Provider** | No | No | Yes (Read only) |

---

## How to Generate a Workstation Pairing Token

1. Sign into **LamaniHub** at [https://lamanihub.com](https://lamanihub.com).
2. Use the branch switcher at top-left to select the clinic location you are provisioning.
3. Click **Settings** in the bottom left sidebar, then click **Integrations**.
4. Locate the **LamaniSync Workstation Bridge** card and click **Manage Workstations**.
5. Click the crimson **+ Pair New Workstation** button.
6. Provide an intuitive label for the workstation (e.g., \`Reception-PC-01\` or \`Dr-Tan-NurseStation\`).
7. Choose your CMS adapter type from the dropdown:
   - *Dentrix Ascend (Cloud)*
   - *eClinicalWorks (Web/Cloud)*
   - *LamaniPulse EHR (Native Adapter)*
   - *Custom Web CMS (Declarative Manifest)*
8. Click **Generate Pairing Token**.

\`\`\`json
{
  "token_id": "tok_991823aef01b",
  "clinic_id": "clinic_kualalumpur_main",
  "workstation_label": "Reception-PC-01",
  "adapter_type": "dentrix_ascend",
  "expires_in_seconds": 900,
  "created_at": "2026-09-24T14:00:00Z"
}
\`\`\`

---

## Token Lifecycle & Security Controls

Every token generated by LamaniHub adheres to strict ephemeral security standards:

- **15-Minute Expiration Window**: Tokens not paired within 15 minutes are automatically invalidated.
- **Single-Use Binding**: Once a token is consumed by a workstation during the WebCrypto handshake, it cannot be reused. Subsequent workstations require their own unique token.
- **Cryptographic Device Binding**: During pairing, the workstation binds its unique Ed25519 public key to the clinic account. Even if the original token string were intercepted, it cannot be used from another machine.
- **Instant Revocation**: If a front-desk laptop is replaced, stolen, or decommissioned, click **Revoke Device** in the LamaniHub dashboard to sever all bridge permissions instantly.
    `,
  },

  // 3. CMS Connection Guides: Dentrix Ascend Setup
  {
    slug: 'dentrix-ascend-setup',
    title: 'Connecting Dentrix Ascend (Cloud)',
    description: 'Step-by-step connection guide for Dentrix Ascend: organization alias setup, dedicated front-desk user roles, exact-origin rules, and verified writeback.',
    category: 'CMS Connection Guides',
    categorySlug: 'cms-connection-guides',
    order: 1,
    readTime: '5 min read',
    lastUpdated: 'September 2026',
    popular: true,
    content: `
## Dentrix Ascend Integration Architecture

**Dentrix Ascend** is a popular cloud-based dental practice management platform. LamaniSync interfaces directly with Dentrix Ascend's web interface via an ambient in-browser bridge, observing the authenticated schedule ledger and dispatching verified appointment bookings.

\`\`\`plain text
[Dentrix Ascend Web Tab]
  ├── URL: https://live.dentrixascend.com
  ├── Operatory Calendar Ledger (DOM & JSON State)
  └── Staff Authenticated Cookie Session
         ▲
         │ (Isolated MV3 In-Memory Bridge)
         ▼
[LamaniSync Extension]
  └── Predefined Action: DENTRIX_SCHEDULE_READ / WRITE
\`\`\`

---

## Step 1: Gather Practice Identifiers

Before configuring the bridge, ensure you have:

1. **Dentrix Ascend Login URL**: Standard cloud endpoint is \`https://live.dentrixascend.com\`.
2. **Organization Alias (ORG ID)**: Found in your Dentrix Ascend portal under **Settings → Organization → Practice Profile**.
3. **Practice Location ID**: If your dental organization operates multiple physical offices under one account.

---

## Step 2: Configure Dedicated Sync User (Recommended)

To guarantee that automatic Sara AI bookings do not conflict with front-desk staff manual scheduling:

1. In Dentrix Ascend, log in as an **Administrator**.
2. Go to **Settings → Users → Add New User**.
3. Name the user \`LamaniSync Service\` or \`Sara AI Bridge\`.
4. Assign the role **Receptionist** or **Front Desk Specialist**.
5. Enable permissions for:
   - **Appointments**: View, Create, Reschedule, Cancel.
   - **Patient Hub**: Search Patient, Create Patient Record.
   - **Operatory Ledger**: Read Operatory Availability.

> **Staff Shared Mode**: If your clinic prefers not to create a dedicated user account, LamaniSync can run seamlessly under any logged-in staff user's session without saving or transmitting their password.

---

## Step 3: Install & Pair LamaniSync on the Workstation

1. Install LamaniSync from the Chrome Web Store on the front-desk workstation.
2. In the LamaniSync popup, enter your pairing token from LamaniHub (with adapter set to \`Dentrix Ascend\`).
3. When prompted, grant origin permission for:
   \`\`\`plain text
   https://live.dentrixascend.com/*
   \`\`\`
4. Open a tab with Dentrix Ascend and sign in.

---

## Step 4: Verify Readback Verification & Operatory Mapping

When Sara AI books an appointment:
1. LamaniSync queries the open Dentrix Ascend tab to check operatory and provider chair availability.
2. The appointment insertion modal is populated using predefined UI actions.
3. The appointment write is submitted.
4. **Mandatory Readback Verification**: LamaniSync immediately re-queries the calendar DOM and verifies that the new appointment ID exists with identical patient name, timestamp, and provider details.
5. Only after readback confirmation does LamaniHub send the booking confirmation to the patient on WhatsApp.
    `,
  },

  // 4. CMS Connection Guides: eClinicalWorks Setup
  {
    slug: 'eclinicalworks-setup',
    title: 'Connecting eClinicalWorks (Cloud/Web)',
    description: 'Configure eCW Web Cloud portal integration: URL discovery, authentication flags, patient hub lookup permissions, and session hygiene.',
    category: 'CMS Connection Guides',
    categorySlug: 'cms-connection-guides',
    order: 2,
    readTime: '6 min read',
    lastUpdated: 'September 2026',
    popular: true,
    content: `
## eClinicalWorks Web Portal Overview

**eClinicalWorks (eCW)** cloud deployments provide a browser-accessible Electronic Health Record (EHR) and Practice Management solution. LamaniSync integrates with eCW v11.53 and newer versions running in Google Chrome.

---

## Step 1: Identify Your Unique Practice Web URL

Every eClinicalWorks cloud instance has a dedicated subdomain. Locate your clinic's web portal URL, which typically follows this structure:

\`\`\`plain text
https://[your-clinic-alias].eclinicalweb.com
\`\`\`

If your clinic uses a multi-facility or hospital system portal, ensure you note the specific URL used by your front-desk staff during daily login.

---

## Step 2: Configure Authentication Settings in eCW

To ensure reliable browser-based synchronization without legacy external launcher interruptions:

1. Log into eClinicalWorks with an **Administrator** profile.
2. In the top navigation bar, click **Menu → File → Authentication Settings**.
3. Verify that **"Enforce eCW URL Launcher for Login"** is set to **False** (Disabled).
4. Save the configuration. This ensures that the web session remains active in standard Chrome tabs.

---

## Step 3: User Role & Security Attribute Setup

Create or configure a user account for the synchronizer with the following attributes:

1. Navigate to **Menu → Security Settings → By Security Attribute**.
2. Ensure the user role has active permissions for:
   - \`Patient Lookup / Search\`
   - \`Create New Patient Profile\`
   - \`Appointment Booking & Schedule Grid\`
   - \`Resource & Provider Allocation\`
3. Verify that the user has access to all provider schedules for which Sara AI will manage online bookings.

---

## Step 4: Workstation Extension Configuration

1. Launch Google Chrome on the reception PC and install LamaniSync.
2. Open the LamaniSync popup and input the pairing token generated in LamaniHub for eClinicalWorks.
3. Grant exact-origin permission for:
   \`\`\`plain text
   https://*.eclinicalweb.com/*
   \`\`\`
4. Log into eClinicalWorks in one tab. Keep the tab open during clinic hours.
5. In the LamaniSync popup, confirm that the status reads **"eCW Adapter Connected - Active Tunnel"**.

---

## eClinicalWorks Troubleshooting Tips

- **Session Timeout Warnings**: eCW enforces session inactivity timeouts (typically 15 to 30 minutes). Ensure staff are aware that at least one workstation running the clinic portal should remain active throughout operating hours.
- **Multiple Provider Calendars**: If your clinic has 10+ doctors, ensure your eCW schedule grid view defaults to "All Providers" or the target department.
    `,
  },

  // 5. CMS Connection Guides: LamaniPulse Setup
  {
    slug: 'lamanipulse-setup',
    title: 'Connecting LamaniPulse EHR (Native Adapter)',
    description: 'High-performance native integration for LamaniPulse EHR: zero-config auto-detection, sub-100ms slot sync, and mutual WebCrypto verification.',
    category: 'CMS Connection Guides',
    categorySlug: 'cms-connection-guides',
    order: 3,
    readTime: '3 min read',
    lastUpdated: 'September 2026',
    popular: false,
    content: `
## Native Architecture with LamaniPulse

**LamaniPulse EHR** is Lamanify's purpose-built healthcare management system designed specifically for private clinics, dental centers, and specialist practices across Southeast Asia.

Because LamaniPulse is built on modern web standards, the LamaniSync integration requires **zero manual DOM scripting** and operates over a high-throughput, native memory channel.

\`\`\`plain text
[LamaniPulse EHR Web Tab]
         │
         │ (Native BroadcastChannel / postMessage API)
         ▼
[LamaniSync MV3 Service Worker]
         │
         │ (Sub-100ms WebCrypto Ed25519 Payload Signing)
         ▼
[LamaniHub Cloud Engine & Sara AI]
\`\`\`

---

## Zero-Configuration Setup

Connecting LamaniPulse takes less than 60 seconds:

1. Install **LamaniSync** from the Chrome Web Store.
2. In the extension popup, paste your LamaniHub pairing token.
3. Open **LamaniPulse EHR** in any tab and log in with your clinic credentials.
4. **Auto-Detection**: LamaniSync automatically detects the verified LamaniPulse session header and completes the mutual WebCrypto handshake.
5. The extension status immediately turns green: \`LamaniPulse Native Bridge Active\`.

---

## Native Adapter Capabilities

When running with LamaniPulse EHR, LamaniSync unlocks exclusive capabilities:

| Feature | Legacy CMS Adapters | LamaniPulse Native |
| :--- | :--- | :--- |
| **Sync Latency** | 500ms – 1200ms | < 80ms (Instantaneous) |
| **Slot Ingestion** | Polled DOM scraping | Event-driven reactive push |
| **Patient Check-in** | Manual status change | Automatic WhatsApp arrival trigger |
| **Double-Booking Prevention** | Workstation-level mutex | Real-time database atomic locks |
| **Doctor Schedule Overrides** | 60-second polling delay | Immediate WebSocket push notification |

---

## Browser Tab Operating Rules & Route Flexibility

### Do Staff Need to Keep the Tab Open Always?

**Yes, during clinic operating hours.**
LamaniSync operates on an **Ambient Authentication** architecture (Rule 4 of our security model). The extension **never** stores or transmits staff passwords, master API keys, or long-lived authentication tokens to the cloud. Instead, it relies on the front-desk staff member's active browser login session.

| State | What Happens | Action Required |
| :--- | :--- | :--- |
| **Tab Open & Active** | Real-time bi-directional synchronization (< 80ms latency). | None (Normal operation) |
| **Tab Open in Background / Another Tab Focused** | Full real-time synchronization continues uninterrupted. | None (Background workers handle events) |
| **Tab Closed Accidentally** | Inbound appointments from LamaniHub queue safely in \`public.sync_outbox\` as \`PENDING\`. Zero data loss. | Reopen any LamaniPulse tab. All queued appointments auto-flush and sync instantly. |

### Does Sync Only Work on \`/appointments\` or Other Pages Too?

**Any page under \`https://app.lamanipulse.com/*\` maintains 100% active sync.**
Staff do **not** need to stay anchored to the \`/appointments\` screen. You can freely navigate throughout the entire system:

- \`/patients\`: Manage patient demographics, registrations, and medical records.
- \`/dashboard\`: View clinic KPI cards and daily overview.
- \`/queue\`: Call patients to consultation rooms and monitor wait times.
- \`/billing\`: Process invoices, insurance claims, and payments.

#### How Multi-Route Sync Functions:

1. **Hub → CMS Writes (Create, Reschedule, Cancel)**:
   - When a patient books or modifies an appointment on WhatsApp with Sara AI, LamaniSync executes the write via the PostgREST data layer directly inside the open page context.
   - This executes seamlessly in the background regardless of whether staff is on \`/patients\`, \`/queue\`, or \`/dashboard\`.
   - When staff later navigates to or refreshes \`/appointments\`, the newly confirmed appointment is already rendered on the calendar.

2. **CMS → Hub Observations (Staff Activity Interception)**:
   - When staff creates or edits patients on \`/patients\`, the in-page observer intercepts the write and replicates it to LamaniHub.
   - When staff edits or cancels bookings on \`/appointments\`, the observer instantly syncs the calendar state to LamaniHub.

3. **In-Page Visual Indicator**:
   - The green LamaniSync sync badge (\`#lamanisync-sync-indicator\`) floats unobtrusively in the bottom-right corner of every page across the portal, giving staff instant visual confirmation of every synchronized record.

---

## Best Practice: Tab Pinning & Chrome Memory Saver

To ensure uninterrupted sync throughout the working day:

1. **Pin the Tab**: Right-click your LamaniPulse tab in Chrome and select **Pin**. A pinned tab stays compact on the left of the tab bar and cannot be closed with a single accidental click.
2. **Prevent Chrome Memory Saver from Discarding the Tab**:
   - Navigate to \`chrome://settings/performance\` in Google Chrome.
   - Under **Always keep these sites active**, click **Add**.
   - Enter \`https://app.lamanipulse.com\` and save.
   - Chrome will never put the clinic tab to sleep.
    `,
  },

  // 6. CMS Connection Guides: Custom Web CMS
  {
    slug: 'custom-web-cms',
    title: 'Connecting Custom & Proprietary Clinic Portals',
    description: 'How to build declarative adapter manifests for custom, proprietary, and regional clinic management web systems without arbitrary code.',
    category: 'CMS Connection Guides',
    categorySlug: 'cms-connection-guides',
    order: 4,
    readTime: '7 min read',
    lastUpdated: 'September 2026',
    popular: false,
    content: `
## Why Predefined Action IDs Matter

Under **Chrome Manifest V3** and strict healthcare compliance guidelines (Rule #8 of LamaniSync Architecture):

> **Page-world code may execute only predefined adapter action IDs — never arbitrary remote URL, method, body, or executable string instructions.**

This architectural guarantee protects your clinic: even if a malicious actor were to intercept cloud traffic, they cannot force the extension to execute unauthorized JavaScript or exfiltrate private patient records.

---

## Declarative Adapter Structure

To support regional or custom clinic web portals (such as custom Laravel, React, or legacy ASP.NET portals), LamaniSync uses **Declarative Manifests**:

\`\`\`json
{
  "adapter_id": "custom-clinic-portal-v1",
  "match_origin": "https://portal.myclinic.com.my/*",
  "version": "1.0.0",
  "actions": {
    "READ_AVAILABLE_SLOTS": {
      "target_selector": "#calendar-grid-container",
      "slot_row_selector": ".slot-available",
      "time_attr": "data-slot-time",
      "doctor_attr": "data-doctor-id"
    },
    "INSERT_APPOINTMENT": {
      "open_modal_btn": "#btn-new-appointment",
      "patient_name_input": "input[name='patient_name']",
      "phone_input": "input[name='contact_phone']",
      "time_select": "select[name='appointment_slot']",
      "submit_btn": "#btn-confirm-save"
    },
    "VERIFY_WRITEBACK": {
      "calendar_entry_selector": ".appointment-card[data-booking-id='{ID}']",
      "success_banner_selector": ".toast-success"
    }
  }
}
\`\`\`

---

## Step-by-Step Onboarding for Custom Portals

1. **Schedule Technical Assessment**: Contact our engineering team at [support@lamanify.com](mailto:support@lamanify.com) with details of your clinic's web portal.
2. **Schema Definition**: Our team creates a sandboxed declarative manifest matching your portal's DOM hierarchy.
3. **Safety Validation**: The manifest is statically verified against our Zod schema validator and signed with LamaniHub's deployment key.
4. **Zero-Update Rollout**: The manifest loads into your workstation's extension securely as data — requiring zero reinstallation or browser restarts.
    `,
  },

  // 7. Clinic Operations: Multi-Workstation Redundancy
  {
    slug: 'multi-workstation-redundancy',
    title: 'Multi-Workstation Setup & Automatic Active Lease Election',
    description: 'Eliminate single points of failure by deploying LamaniSync across 2 to 5 reception desks with 15-second distributed lease election.',
    category: 'Clinic Operations & Deployment',
    categorySlug: 'clinic-operations',
    order: 1,
    readTime: '5 min read',
    lastUpdated: 'September 2026',
    popular: true,
    content: `
## The Front-Desk Fragility Problem

In a busy healthcare practice, front-desk computers are subject to routine operational disruptions:
- A receptionist steps away for lunch or closes their laptop.
- Windows updates trigger an unexpected system restart.
- An ethernet cable is bumped or Wi-Fi experiences temporary signal loss.

If your clinic synchronizer relies on a single computer, any of these events immediately pauses Sara AI online booking.

---

## The Solution: Active / Warm-Standby Lease Election

LamaniSync solves this with a **Distributed Lease Election Protocol** modeled after modern cloud consensus engines:

\`\`\`plain text
LamaniHub Cloud Coordinator
         │
         ├── Heartbeat (15s Lease) ──> [Workstation 1 (Front Desk)] -> ACTIVE LEADER (Writes)
         ├── Heartbeat (15s Lease) ──> [Workstation 2 (Reception 2)] -> WARM STANDBY (Listening)
         └── Heartbeat (15s Lease) ──> [Workstation 3 (Office Mgr)]  -> WARM STANDBY (Listening)
\`\`\`

### How Lease Election Operates:

1. **One Active Leader**: Only ONE workstation holds the active write lease at any given second. This workstation handles all appointment dispatch and readback verification.
2. **Warm Standby Nodes**: All other paired workstations remain in "Warm Standby." They keep authenticated CMS tabs open and maintain an active WebSocket connection to LamaniHub.
3. **15-Second Heartbeat**: The Active Leader sends a cryptographic heartbeat every 5 seconds to renew its 15-second lease.
4. **Seamless Automatic Failover (< 20 Seconds)**:
   - If Workstation 1 loses power or goes to sleep, its 15-second lease expires.
   - LamaniHub automatically promotes Workstation 2 to **Active Leader**.
   - Online bookings continue without dropping a single appointment.
   - Front-desk staff require zero training and need not touch a single button.

---

## Best Practice Deployment Recommendations

For maximum clinic uptime, we recommend installing LamaniSync on:

| Workstation Location | Recommended Mode | Purpose |
| :--- | :--- | :--- |
| **Front Desk Primary PC** | Normal Use | Primary Active Leader during clinic open hours |
| **Front Desk Secondary PC** | Normal Use | Instant backup failover node |
| **Office Manager Desktop** | Normal Use | Stable wired backup node |
| **Dedicated Server / Mini PC** | Headless Chrome (Optional) | For 24/7 night-time and weekend automated bookings |

---

## Double-Booking Shield & Mutex Locks

When multiple workstations are connected to the same clinic CMS:
- **Idempotency Keys**: Every Sara AI booking intent contains a unique UUIDv4 token.
- **Atomic Mutex**: Before executing a calendar write, the active workstation acquires a distributed mutex lock in memory.
- Even if two patients click "Confirm" on WhatsApp at the exact same millisecond, LamaniHub serializes the dispatches, guaranteeing **zero double bookings**.
    `,
  },

  // 8. Clinic Operations: Security & Firewall
  {
    slug: 'security-and-firewall',
    title: 'Clinic IT Network & Firewall Configuration (0 Inbound Ports)',
    description: 'Clinic IT and network administrator guide: 0 inbound ports, outbound TLS 1.3 over port 443, memory-only execution, and PDPA/HIPAA compliance.',
    category: 'Clinic Operations & Deployment',
    categorySlug: 'clinic-operations',
    order: 2,
    readTime: '6 min read',
    lastUpdated: 'September 2026',
    popular: true,
    content: `
## Overview for Clinic IT & Network Administrators

Traditional clinic synchronizers are a cybersecurity nightmare for healthcare IT departments. They frequently require:
- Installing unverified Windows \`.exe\` or \`.bat\` background services.
- Opening inbound database ports (e.g. MySQL port 3306 or MS SQL port 1433) to the public internet.
- Setting up complex dynamic DNS, port forwarding, or site-to-site VPN tunnels.

**LamaniSync eliminates 100% of these attack vectors.**

---

## The 0 Inbound Open Ports Guarantee

LamaniSync operates strictly as an **Outbound-Only Workstation Bridge**:

\`\`\`plain text
Clinic Internal Network                     Public Internet              LamaniHub Cloud
┌───────────────────────────────┐           ┌──────────────┐             ┌─────────────────┐
│ Front-Desk PC (LamaniSync)    │ ────────> │ NAT Firewall │ ──────────> │ WSS TLS 1.3     │
│ Port: Dynamic Outbound Client │  OUTBOUND │ (0 INBOUND   │  PORT 443   │ *.lamanihub.com │
│                              │   TRAFFIC │  PORTS OPEN) │             │                 │
└───────────────────────────────┘           └──────────────┘             └─────────────────┘
                                                   ▲
                                                   │
                                     BLOCKED: All Inbound Connections
\`\`\`

- **0 Inbound Ports**: The workstation never listens on any local port. Incoming probes from external networks are dropped by default.
- **Port 443 Only**: All traffic traverses standard HTTPS/WSS (Port 443) using modern **TLS 1.3** encryption.
- **Zero Inbound NAT / Port Forwarding**: Clinic routers require zero special configuration or DMZ setups.

---

## IT Firewall Whitelist Rules

If your clinic network enforces strict outbound URL filtering, add the following endpoints to your firewall allowlist:

| Destination Domain | Protocol | Port | Description |
| :--- | :--- | :--- | :--- |
| \`*.lamanihub.com\` | HTTPS / WSS | 443 | Real-time bi-directional telemetry & dispatch |
| \`*.lamanify.com\` | HTTPS | 443 | Manifest distribution & cryptographic keys |
| \`chrome.google.com\` | HTTPS | 443 | Chrome Web Store automatic updates |

---

## The Zero-Disk & Zero-PHI Guarantee

To satisfy strict healthcare privacy standards:

1. **Pure Ephemeral RAM Execution**: LamaniSync runs strictly inside Chrome's sandboxed worker memory. It never writes appointment details, patient names, IC/NRIC numbers, or medical notes to local disk.
2. **Zero chrome.storage.local for PHI**: The extension uses browser storage exclusively for pairing tokens and public keys. Patient health information is processed in-flight and discarded immediately following readback verification.
3. **No Password Storing**: LamaniSync operates inside the authenticated browser session established by your front-desk staff. It never requests, captures, or transmits CMS passwords to any server.

---

## Regulatory Compliance Matrix

| Regulation | Requirement | LamaniSync Implementation |
| :--- | :--- | :--- |
| **Malaysian PDPA 2010** | Principle 9 (Security Principle) | End-to-end WebCrypto Ed25519 payload signing |
| **HIPAA (US)** | 45 CFR § 164.312 (Technical Safeguards) | Outbound TLS 1.3, zero disk persistence, audit trail |
| **Chrome Web Store** | Manifest V3 Policy | Zero remote code execution, sandboxed CSP |
    `,
  },

  // 9. Troubleshooting: Pairing & Drops
  {
    slug: 'troubleshooting-pairing',
    title: 'Troubleshooting Pairing & Connection Drops',
    description: 'Diagnose and resolve connection errors, ERR_TOKEN_EXPIRED, ERR_HOST_PERMISSION_DENIED, Chrome tab sleep settings, and network drops.',
    category: 'Troubleshooting & Support',
    categorySlug: 'troubleshooting-and-support',
    order: 1,
    readTime: '5 min read',
    lastUpdated: 'September 2026',
    popular: true,
    content: `
## Diagnostic Checklist

If the LamaniSync extension status badge is not displaying green, check these four essentials first:

1. Is the clinic workstation connected to the internet?
2. Is the clinic CMS tab open in Google Chrome and actively logged in?
3. Is the LamaniSync extension icon pinned to your Chrome toolbar?
4. What error code is shown in the extension popup?

---

## Error Code Reference Guide

| Error Code | Meaning | Remediation Steps |
| :--- | :--- | :--- |
| \`ERR_TOKEN_EXPIRED\` | The pairing token was generated over 15 minutes ago. | Return to LamaniHub, click **Generate New Token**, and pair within 15 minutes. |
| \`ERR_HOST_PERMISSION_DENIED\` | The user clicked "Block" or cancelled the origin permission prompt. | Right-click the extension icon → **Manage Extension** → **Site Access** → Select **On specific sites** and add your CMS URL. |
| \`ERR_MUTEX_TIMEOUT\` | Another workstation currently holds the active write lease. | This is normal multi-workstation behavior. The current workstation will remain in standby until needed. |
| \`ERR_CMS_SESSION_EXPIRED\` | The front-desk user was logged out of the CMS portal. | Re-authenticate into your clinic CMS in the open browser tab. |
| \`ERR_READBACK_FAILED\` | The appointment was written, but verification failed to find it in the calendar. | Check if the selected time slot was manually blocked in the CMS. Sara AI automatically alerts front desk. |
| \`ERR_WEBSOCKET_DISCONNECT\` | Temporary internet drop or network proxy interruption. | LamaniSync automatically reconnects with exponential backoff (1s, 2s, 4s, 8s). |

---

## Preventing Chrome Tab Discarding (Memory Saver)

Modern versions of Google Chrome feature an aggressive **Memory Saver** that suspends background tabs after periods of inactivity. If staff leave the CMS tab in the background, Chrome might put it to sleep.

### How to Keep Your CMS Tab Always Active:

1. In Chrome, open settings by visiting:
   \`\`\`plain text
   chrome://settings/performance
   \`\`\`
2. Look for the **"Always keep these sites active"** section.
3. Click **Add**.
4. Enter the domain of your clinic CMS (e.g., \`live.dentrixascend.com\` or \`*.eclinicalweb.com\`).
5. Click **Add**.

Now Chrome will never suspend or discard your clinic calendar tab, ensuring 24/7 background availability.

---

## Antivirus & Web Shield Whitelisting

Certain enterprise antivirus suites (such as Kaspersky, Norton, or Bitdefender) feature SSL inspection that can interfere with secure WebSocket handshakes.

If your connection drops repeatedly:
- Add \`*.lamanihub.com\` to your antivirus **SSL Exclusion / Web Shield Whitelist**.
- Confirm that your workstation clock is synchronized to internet time (NTP). An incorrect system clock will cause WebCrypto certificate validation to fail.
    `,
  },

  // 10. Troubleshooting: FAQ
  {
    slug: 'faq',
    title: 'Frequently Asked Questions for Clinic Staff & Doctors',
    description: 'Common questions from clinic owners, receptionists, and doctors regarding computer performance, internet outages, patient privacy, and compliance.',
    category: 'Troubleshooting & Support',
    categorySlug: 'troubleshooting-and-support',
    order: 2,
    readTime: '6 min read',
    lastUpdated: 'September 2026',
    popular: false,
    content: `
## General Questions

### Does LamaniSync slow down our clinic computers?
**No.** LamaniSync is engineered as a lightweight, reactive Manifest V3 extension. It consumes less than **25 megabytes of RAM** (less than a single open web page) and uses negligible CPU because it does not run continuous polling loops. It activates only when an appointment event occurs or a heartbeat tick is due.

### What happens if our clinic internet goes down?
If your clinic experiences a power outage or internet disconnection:
1. Sara AI on WhatsApp detects the lease expiration and informs inquiring patients: *"Our clinic calendar is momentarily updating. Let me record your booking request and our front desk will confirm your slot within 10 minutes."*
2. Booking requests are securely queued in LamaniHub cloud.
3. As soon as your clinic internet restores, LamaniSync automatically reconnects, ingests the queue, and writes the appointments into your CMS. Zero patient bookings are lost.

### Can multiple staff members be logged into the CMS at once?
**Yes.** Most dental and medical clinics operate 2 to 4 reception desks. You can install LamaniSync on all front-desk machines. The extension automatically elects a **Primary Leader** and keeps the other machines in **Warm Standby**, ensuring redundancy without duplicate bookings.

---

## Security & Data Privacy

### Does LamaniSync save or store patient health records?
**No.** LamaniSync operates under a strict **Zero-Disk Guarantee**. Patient names, identification numbers, and appointment notes are held in transient memory only for the fraction of a second needed to complete writeback verification, and are then immediately flushed from RAM. No PHI is written to browser cookies, local storage, or workstation files.

### Does LamaniSync see or transmit our CMS master password?
**Never.** LamaniSync operates ambiently within the authenticated browser session that your staff logged into with their own credentials. The extension has zero access to your keystrokes, password managers, or raw password hashes.

### Is LamaniSync compliant with healthcare privacy regulations?
**Yes.** LamaniSync is built to comply with both the **Malaysian Personal Data Protection Act (PDPA 2010)** and the **US Health Insurance Portability and Accountability Act (HIPAA)**. All payload transmissions use end-to-end WebCrypto Ed25519 cryptographic signatures and TLS 1.3 encryption.

---

## Clinic Operations

### What if a patient cancels or reschedules on WhatsApp?
When a patient requests a cancellation or reschedule with Sara AI:
1. Sara AI checks clinic policy (e.g. minimum 24-hour notice).
2. If approved, Sara AI dispatches an update action to LamaniSync.
3. LamaniSync modifies the appointment status in your CMS calendar and verifies the cancellation.
4. The cancelled slot is immediately restored as available for other patients to book.

### Can we manually override or block times in the CMS?
**Yes.** When doctors block time off for surgery, personal leave, or lunch breaks directly in the CMS calendar, LamaniSync detects the block in real-time. Sara AI will never offer a blocked slot to a patient.

### Do we always need to keep a CMS tab open in Chrome?
**Yes, during clinic operating hours.**
LamaniSync relies on **ambient credentials** from your logged-in clinic portal session. This security design guarantees that your CMS master passwords and tokens are never stored on disk or sent to the cloud. Pinning the CMS tab (\`Right-click tab\` → \`Pin\`) keeps the session open seamlessly throughout the day without cluttering the screen.

### What happens if staff accidentally closes the CMS tab?
**Zero appointments or patient data are lost.**
1. Any new bookings created from WhatsApp or LamaniHub safely wait in the cloud outbox queue (\`public.sync_outbox\`) with status \`PENDING\`.
2. As soon as a receptionist reopens or logs back into the CMS portal, LamaniSync automatically detects the tab, claims the pending queue, and syncs all bookings into the calendar immediately.

### Does LamaniSync only work when looking at the /appointments tab?
**No, it works across every page in the CMS.**
LamaniSync is registered across the entire CMS domain (\`https://app.lamanipulse.com/*\`). Staff can work normally on \`/patients\`, \`/queue\`, \`/dashboard\`, or \`/billing\`. Inbound appointments from WhatsApp are written directly to the database in the page background, and the green sync badge in the lower-right corner confirms successful synchronization regardless of which screen is currently visible.

### Who do we contact if we need help with setup?
Our healthcare solutions engineering team provides free live onboarding assistance for all LamaniHub clinics. Reach out via WhatsApp or email:
- **Email**: [support@lamanify.com](mailto:support@lamanify.com)
- **Help Center**: [https://lamanisync.com/contact](/contact)
    `,
  },
];

// Populate categories with their respective articles
docCategories.forEach((cat) => {
  cat.articles = docArticles
    .filter((art) => art.categorySlug === cat.slug)
    .sort((a, b) => a.order - b.order);
});
