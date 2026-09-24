# LamaniSync — Clinic Management System (CMS) & EMR Data Synchronization

> **Universal clinic system synchronization bridge for LamaniHub.** Keep your existing Clinic Management System while enabling real-time appointment and patient workflow sync without complex API integrations or staff retraining.

---

### Need to Integrate Your Clinic's CMS?
LamaniSync provides turnkey, certified integration for any web-based clinic management system (Dental, Medical GP, Specialist EHRs, or proprietary hospital portals).

👉 **[Contact Us for CMS Integration](https://lamanisync.com/contact)** *(Fast 48-Hour Turnaround)*

---

## Overview

LamaniSync operates as a secure, healthcare-compliant browser bridge providing bi-directional synchronization between web-based clinic management systems and LamaniHub.

* **Universal Compatibility**: Connects with any web-based clinic management software and EHR platform.
* **Zero Credential Exposure**: Never stores or transmits raw healthcare login credentials.
* **Real-Time Verification**: Instant readback confirmation prevents double-bookings and scheduling conflicts.
* **Privacy Compliant**: Built strictly adhering to healthcare privacy and data protection standards (PDPA / HIPAA compliant architecture).

## Prerequisites

- Node.js LTS (v20+ recommended)
- pnpm (or npm)
- Google Chrome Stable (or Canary with separate `LamaniSync Dev` profile)

## Setup

1. Clone repository:
   ```bash
   git clone git@github.com:lamanify/lamanisync-extension.git
   cd lamanisync-extension
   ```

2. Copy environment template:
   ```bash
   cp .env.example .env
   ```

3. Install dependencies:
   ```bash
   pnpm install
   ```

## Development & Build Scripts

- `pnpm dev`: Start Vite development server with HMR.
- `pnpm build`: Compile production extension bundle.
- `pnpm lint`: Run ESLint checks across codebase.
- `pnpm typecheck`: Run TypeScript compiler type checking without emitting files.
- `pnpm test`: Execute Vitest unit test suite.
- `pnpm test:contract`: Run adapter contract validation test suite.
- `pnpm test:e2e`: Run Playwright end-to-end extension integration tests.
- `pnpm package`: Build and package ZIP distribution for Chrome Web Store.

## Governance & Rules

All contributors and AI agents must strictly adhere to the 14 non-negotiable rules defined in [AGENTS.md](AGENTS.md).
