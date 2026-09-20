#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

console.log('Running contract, state machine & error taxonomy runtime tests (Phase 3)...');
const res = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    'tests/unit/contracts.test.ts',
    'tests/unit/adapter-manifest.test.ts',
    'tests/unit/connection-fsm.test.ts',
    'tests/unit/command-fsm.test.ts',
    'tests/unit/error-taxonomy.test.ts',
  ],
  {
    stdio: 'inherit',
  }
);

process.exit(res.status ?? 0);
