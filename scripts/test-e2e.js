#!/usr/bin/env node
/**
 * Automated E2E Browser & Runtime Scenario Runner (Phase 11)
 * Executes the 15 required edge and operational scenarios against local mock servers.
 */

import { spawnSync } from 'node:child_process';

console.log('Running 15 Automated Browser & Runtime E2E Scenarios (Phase 11)...');

const res = spawnSync(
  'npx',
  ['vitest', 'run', 'tests/e2e/e2e-scenarios.test.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  }
);

if (res.status !== 0) {
  console.error('\nE2E Scenario validation failed.');
  process.exit(res.status ?? 1);
}

console.log('\nAll 15 E2E Browser & Runtime Scenarios passed successfully.');
process.exit(0);
