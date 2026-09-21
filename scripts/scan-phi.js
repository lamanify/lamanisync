#!/usr/bin/env node
/**
 * Automated PHI & Secrets Scanner (Phase 11)
 * Strictly enforces AGENTS.md:
 * Rule 4: Never copy or transmit CMS passwords, cookies, bearer tokens, or CSRF secrets to LamaniHub.
 * Rule 5: Never use production patient data or credentials in development or tests.
 * Rule 6: Do not store raw PHI in chrome.storage.local.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();

// Directories strictly requiring zero PHI and zero secrets
const PRODUCTION_DIRS = ['src', 'dist'];
// Harness and test directories checked for production secrets and unredacted production patient data
const SUPPORT_DIRS = ['scripts', 'test-harness', 'tests'];

// Allowed file extensions
const VALID_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.md']);

// Known synthetic patterns allowed strictly in tests/fixtures
const SYNTHETIC_ALLOWLIST = new Set([
  '900101-14-5001',
  '920202-10-5002',
  '880303-14-5003',
  '950404-08-5004',
  '950101-14-1234',
  '990101-14-9999',
  '821021-14-5566',
  '000000-00-0000',
  '012-999 8877',
  '011-2345 6789',
  '+60123456701',
  '+60123456702',
  '+60123456703',
  '+60123456704',
  '+60129998877',
  '+601123456789',
]);

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GitHub Personal Token', regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g },
  { name: 'Production Live Secret', regex: /\b(sk|lh)_live_[0-9a-zA-Z]{16,}\b/g },
  { name: 'Production Private Key Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

const MALAYSIAN_IC_REGEX = /\b\d{6}-\d{2}-\d{4}\b/g;

let totalFilesScanned = 0;
const violations = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') {
        files.push(...walk(fullPath));
      }
    } else if (VALID_EXTS.has(path.extname(entry.name))) {
      // Do not scan the scanner script itself
      if (fullPath !== import.meta.filename && !fullPath.endsWith('scripts/scan-phi.js')) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

const allDirs = [...PRODUCTION_DIRS, ...SUPPORT_DIRS];
const allFiles = allDirs.flatMap((d) => walk(path.join(ROOT_DIR, d)));

for (const filePath of allFiles) {
  totalFilesScanned += 1;
  const content = fs.readFileSync(filePath, 'utf-8');
  const relPath = path.relative(ROOT_DIR, filePath);
  const isTestOrFixture = relPath.startsWith('tests/') || relPath.startsWith('test-harness/');

  // 1. Check Secret Patterns
  for (const { name, regex } of SECRET_PATTERNS) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      // In test harness only, synthetic test signing keys and redaction test fixtures are permitted
      if (isTestOrFixture && (content.includes('TEST_PRIVATE_KEY') || content.includes('TEST KEY') || content.includes('dummy_key') || content.includes('redactSensitiveData'))) {
        continue;
      }
      violations.push({
        file: relPath,
        type: `Secret Detected: ${name}`,
        snippet: match[0].substring(0, 8) + '...',
      });
    }
  }

  // 2. Check Malaysian IC Numbers
  let icMatch;
  while ((icMatch = MALAYSIAN_IC_REGEX.exec(content)) !== null) {
    const matchedIc = icMatch[0];
    if (isTestOrFixture && SYNTHETIC_ALLOWLIST.has(matchedIc)) {
      // Allowed synthetic test fixture
      continue;
    }
    // Check if surrounding line contains ZZTEST or synthetic test tag
    const lineStart = content.lastIndexOf('\n', icMatch.index);
    const lineEnd = content.indexOf('\n', icMatch.index);
    const line = content.substring(lineStart === -1 ? 0 : lineStart, lineEnd === -1 ? content.length : lineEnd);
    if (isTestOrFixture && (line.includes('ZZTEST') || line.includes('synthetic') || line.includes('tainted'))) {
      continue;
    }

    violations.push({
      file: relPath,
      type: 'Unredacted Malaysian IC / Potential PHI',
      snippet: matchedIc.substring(0, 6) + '-XX-XXXX',
    });
  }

  // 3. Check for Raw PHI / CMS credentials stored in local storage (AGENTS.md Rules 4 & 6)
  if (relPath.startsWith('src/background/') || relPath.startsWith('src/storage/')) {
    if (content.includes('chrome.storage.local.set') && (content.includes('cmsPassword') || content.includes('bearerToken') || content.includes('icOrPassport'))) {
      violations.push({
        file: relPath,
        type: 'AGENTS.md Rule 4/6 Violation: Potential CMS secret or raw PHI saved to chrome.storage.local',
        snippet: 'chrome.storage.local.set with sensitive keys',
      });
    }
  }
}

console.log(`[PHI & Secret Scanner] Scanned ${totalFilesScanned} files across project.`);

if (violations.length > 0) {
  console.error(`\nFAILED: Found ${violations.length} security / PHI violations:\n`);
  for (const v of violations) {
    console.error(`  - [${v.type}] in ${v.file} (snippet: ${v.snippet})`);
  }
  console.error('\nPlease remove or redact production credentials and real patient data.');
  process.exit(1);
}

console.log('[PHI & Secret Scanner] PASS: Zero production secrets or unredacted PHI found.');
process.exit(0);
