# LamaniSync Chrome Extension

Secure bridge connecting authenticated cloud CMS tabs to LamaniHub sync services.

## Overview

LamaniSync operates as a Manifest V3 Chrome Extension providing bi-directional, allowlisted synchronization between healthcare CMS platforms and LamaniHub without storing raw credentials or transmitting sensitive patient health information unencrypted.

See [docs/architecture.md](docs/architecture.md) for architectural data flow.

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
