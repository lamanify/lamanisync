#!/usr/bin/env node
/**
 * scripts/package.js
 * Reproducible Chrome Web Store packaging script for LamaniSync.
 * Builds production extension, validates boundaries, and creates deterministic ZIP bundle.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Prohibited patterns in release package
const FORBIDDEN_PATTERNS = [
  /\.env(\..+)?$/i,
  /\.map$/i,
  /\.(test|spec)\.[jt]sx?$/i,
  /mock/i,
  /test-harness/i,
  /\.git/i,
  /\.ts$/i,
  /\.tsx$/i,
  /node_modules/i,
];

// Required files in production extension
const REQUIRED_FILES = [
  'manifest.json',
  'popup.html',
  'content-script.js',
  'page-world.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

/**
 * Creates a deterministic ZIP archive from an array of file entries.
 * Sets fixed DOS timestamps and sorts entries lexicographically.
 *
 * @param {Array<{ path: string, data: Buffer }>} fileEntries
 * @returns {Buffer}
 */
export function createDeterministicZip(fileEntries) {
  const sorted = [...fileEntries].sort((a, b) => a.path.localeCompare(b.path));

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  // Fixed DOS timestamp: 2026-01-01 00:00:00 UTC for byte-level reproducibility
  // (2026 - 1980) << 9 | (1 << 5) | 1 = 23585
  const dosTime = 0;
  const dosDate = (46 << 9) | (1 << 5) | 1;

  for (const file of sorted) {
    const nameBuf = Buffer.from(file.path.replace(/\\/g, '/'), 'utf8');
    const uncompressed = file.data;
    const compressed = zlib.deflateRawSync(uncompressed, { level: 9 });
    const crc = zlib.crc32(uncompressed);

    // Local file header (30 bytes + nameBuf.length)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local header signature
    lh.writeUInt16LE(20, 4); // version needed to extract (2.0)
    lh.writeUInt16LE(0x0800, 6); // general purpose bit flag (UTF-8)
    lh.writeUInt16LE(8, 8); // compression method (Deflate)
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(uncompressed.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra field length

    localHeaders.push(lh, nameBuf, compressed);

    // Central directory header (46 bytes + nameBuf.length)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory signature
    ch.writeUInt16LE(20, 4); // version made by (2.0)
    ch.writeUInt16LE(20, 6); // version needed (2.0)
    ch.writeUInt16LE(0x0800, 8); // flags (UTF-8)
    ch.writeUInt16LE(8, 10); // compression method (Deflate)
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(uncompressed.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra field length
    ch.writeUInt16LE(0, 32); // comment length
    ch.writeUInt16LE(0, 34); // disk number start
    ch.writeUInt16LE(0, 36); // internal file attributes
    ch.writeUInt32LE(0x81a40000, 38); // external file attributes (-rw-r--r--)
    ch.writeUInt32LE(offset, 42); // relative offset of local header

    centralHeaders.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + compressed.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralHeaders);
  const centralDirSize = centralDirBuf.length;

  // End of Central Directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(sorted.length, 8); // total records on disk
  eocd.writeUInt16LE(sorted.length, 10); // total records
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20); // zip comment length

  return Buffer.concat([...localHeaders, centralDirBuf, eocd]);
}

/**
 * Parses Central Directory of a ZIP buffer and returns entry metadata.
 *
 * @param {Buffer} zipBuffer
 * @returns {Array<{ name: string, compressedSize: number, uncompressedSize: number }>}
 */
export function readZipEntries(zipBuffer) {
  const entries = [];
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('EOCD record not found: invalid ZIP buffer');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let cur = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    const sig = zipBuffer.readUInt32LE(cur);
    if (sig !== 0x02014b50) {
      throw new Error(`Invalid central directory header signature at offset ${cur}`);
    }
    const compressedSize = zipBuffer.readUInt32LE(cur + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cur + 24);
    const nameLen = zipBuffer.readUInt16LE(cur + 28);
    const extraLen = zipBuffer.readUInt16LE(cur + 30);
    const commentLen = zipBuffer.readUInt16LE(cur + 32);
    const name = zipBuffer.toString('utf8', cur + 46, cur + 46 + nameLen);
    entries.push({ name, compressedSize, uncompressedSize });
    cur += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Collects all files in a directory recursively.
 *
 * @param {string} dir
 * @param {string} baseDir
 * @returns {string[]} relative file paths
 */
function collectFiles(dir, baseDir = dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(collectFiles(fullPath, baseDir));
    } else {
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      results.push(relPath);
    }
  }
  return results;
}

/**
 * Main packaging routine.
 */
export function packageExtension(options = {}) {
  const distDir = path.resolve(rootDir, 'dist');
  const releaseDir = path.resolve(rootDir, 'release');
  const pkgJsonPath = path.resolve(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const version = pkg.version || '0.1.0';

  // 1. Ensure icons exist
  const icon16 = path.resolve(rootDir, 'public/icons/icon-16.png');
  if (!fs.existsSync(icon16)) {
    console.log('[package] Generating icons...');
    execSync('node scripts/generate-icons.js', { stdio: 'inherit', cwd: rootDir });
  }

  // 2. Build production bundle cleanly unless skipped
  if (!options.skipBuild) {
    console.log('[package] Running production build (tsc && vite build)...');
    execSync('npm run build', { stdio: 'inherit', cwd: rootDir });
  }

  if (!fs.existsSync(distDir)) {
    throw new Error(`Build directory not found: ${distDir}`);
  }

  // 3. Collect files and enforce boundaries
  const relFiles = collectFiles(distDir);
  const fileEntries = [];

  for (const relPath of relFiles) {
    // Check forbidden patterns
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(relPath)) {
        throw new Error(`Integrity error: forbidden file detected in build output: ${relPath}`);
      }
    }

    const fullPath = path.join(distDir, relPath);
    const data = fs.readFileSync(fullPath);
    fileEntries.push({ path: relPath, data });
  }

  // 4. Validate mandatory files
  for (const required of REQUIRED_FILES) {
    const found = fileEntries.some((e) => e.path === required);
    if (!found) {
      throw new Error(`Integrity error: missing required package file: ${required}`);
    }
  }

  // 5. Verify background worker presence
  const manifestEntry = fileEntries.find((e) => e.path === 'manifest.json');
  if (!manifestEntry) {
    throw new Error('Integrity error: manifest.json missing from package entries');
  }
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  const swFile = manifest.background?.service_worker;
  if (!swFile || !fileEntries.some((e) => e.path === swFile)) {
    throw new Error(`Integrity error: background service worker '${swFile}' missing from package`);
  }

  // 6. Build deterministic ZIP
  const zipBuffer = createDeterministicZip(fileEntries);
  const sha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex');

  // 7. Write to release directory
  fs.mkdirSync(releaseDir, { recursive: true });
  const versionedZipName = `lamanisync-extension-v${version}.zip`;
  const canonicalZipName = `lamanisync-extension.zip`;
  const versionedZipPath = path.join(releaseDir, versionedZipName);
  const canonicalZipPath = path.join(releaseDir, canonicalZipName);
  const sha256FilePath = path.join(releaseDir, `${versionedZipName}.sha256`);

  fs.writeFileSync(versionedZipPath, zipBuffer);
  fs.writeFileSync(canonicalZipPath, zipBuffer);
  fs.writeFileSync(sha256FilePath, `${sha256}  ${versionedZipName}\n`);

  const summary = {
    version,
    versionedZipName,
    canonicalZipName,
    versionedZipPath,
    canonicalZipPath,
    sizeBytes: zipBuffer.length,
    sizeKb: (zipBuffer.length / 1024).toFixed(2),
    sha256,
    fileCount: fileEntries.length,
    files: fileEntries.map((e) => e.path).sort(),
  };

  console.log('\n========================================================');
  console.log('       LamaniSync Chrome Web Store Package Summary      ');
  console.log('========================================================');
  console.log(`Version:       ${summary.version}`);
  console.log(`Package:       ${summary.versionedZipName}`);
  console.log(`Output:        ${summary.versionedZipPath}`);
  console.log(`Size:          ${summary.sizeBytes} bytes (${summary.sizeKb} KB)`);
  console.log(`SHA-256:       ${summary.sha256}`);
  console.log(`Checksum File: ${sha256FilePath}`);
  console.log(`Packaged Files (${summary.fileCount}):`);
  for (const f of summary.files) {
    console.log(`  - ${f}`);
  }
  console.log('========================================================');
  console.log('[✓] Package built deterministically with zero source leaks.\n');

  return summary;
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    packageExtension();
  } catch (err) {
    console.error('[package] Error:', err.message);
    process.exit(1);
  }
}
