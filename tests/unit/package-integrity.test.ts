// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  createDeterministicZip,
  readZipEntries,
  readZipFileContent,
  packageExtension,
} from '../../scripts/package.js';

describe('Package Integrity & Chrome Web Store Bundle Verification (Phase 13)', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const releaseDir = path.join(rootDir, 'release');
  const distDir = path.join(rootDir, 'dist');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const version = pkgJson.version || '0.1.0';
  const zipPath = path.join(releaseDir, `lamanisync-extension-v${version}.zip`);
  const checksumPath = path.join(releaseDir, `lamanisync-extension-v${version}.zip.sha256`);

  beforeAll(() => {
    // If release zip or dist does not exist, build package
    if (!fs.existsSync(zipPath) || !fs.existsSync(distDir)) {
      packageExtension();
    }
  });

  it('produces release ZIP archive and matching SHA-256 checksum file', () => {
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(fs.existsSync(checksumPath)).toBe(true);

    const zipBuffer = fs.readFileSync(zipPath);
    expect(zipBuffer.length).toBeGreaterThan(10 * 1024); // Greater than 10 KB
    expect(zipBuffer.length).toBeLessThan(10 * 1024 * 1024); // Less than 10 MB

    const computedHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');
    const checksumContent = fs.readFileSync(checksumPath, 'utf8').trim();
    expect(checksumContent).toContain(computedHash);
  });

  it('contains all mandatory Manifest V3 assets in the ZIP archive', () => {
    const zipBuffer = fs.readFileSync(zipPath);
    const entries = readZipEntries(zipBuffer);
    const fileNames = entries.map((e) => e.name);

    expect(fileNames).toContain('manifest.json');
    expect(fileNames).toContain('popup.html');
    expect(fileNames).toContain('content-script.js');
    expect(fileNames).toContain('page-world.js');
    expect(fileNames).toContain('icons/icon-16.png');
    expect(fileNames).toContain('icons/icon-32.png');
    expect(fileNames).toContain('icons/icon-48.png');
    expect(fileNames).toContain('icons/icon-128.png');

    // Parse manifest directly from ZIP archive and verify background service worker exists in package
    const manifestBuf = readZipFileContent(zipBuffer, 'manifest.json');
    const manifestFromZip = JSON.parse(manifestBuf.toString('utf8'));
    expect(manifestFromZip.background?.service_worker).toBeTruthy();
    expect(fileNames).toContain(manifestFromZip.background.service_worker);

    // Verify at least one compiled JS chunk exists in assets/
    const assetScripts = fileNames.filter((f) => f.startsWith('assets/') && f.endsWith('.js'));
    expect(assetScripts.length).toBeGreaterThan(0);
  });

  it('verifies manifest.json inside the bundle conforms strictly to Chrome Web Store MV3 rules', () => {
    const zipBuffer = fs.readFileSync(zipPath);
    const manifestBuf = readZipFileContent(zipBuffer, 'manifest.json');
    const manifest = JSON.parse(manifestBuf.toString('utf8'));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe(version);
    expect(manifest.name).toBeTruthy();
    expect(manifest.description).toBeTruthy();

    // Icons
    expect(manifest.icons).toEqual({
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    });

    // Action popup & icons
    expect(manifest.action?.default_popup).toBe('popup.html');
    expect(manifest.action?.default_icon).toEqual({
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    });

    // Service worker
    expect(manifest.background?.service_worker).toBeTruthy();
    const swContent = readZipFileContent(zipBuffer, manifest.background.service_worker);
    expect(swContent.length).toBeGreaterThan(0);

    // Strict permissions: storage, scripting, alarms
    expect(manifest.permissions).toEqual(['storage', 'scripting', 'alarms']);
    // Host permissions must remain runtime optional only
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeDefined();
  });

  it('guarantees zero test files, mocks, sourcemaps, or source code leaks in release bundle', () => {
    const zipBuffer = fs.readFileSync(zipPath);
    const entries = readZipEntries(zipBuffer);

    const forbiddenPatterns = [
      /\.env/i,
      /\.map$/i,
      /\.(test|spec)\.[jt]sx?$/i,
      /mock/i,
      /test-harness/i,
      /\.git/i,
      /\.ts$/i,
      /\.tsx$/i,
      /node_modules/i,
      /vitest/i,
      /playwright/i,
    ];

    for (const entry of entries) {
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(entry.name),
          `Leaked forbidden file in release package: ${entry.name}`
        ).toBe(false);
      }
    }
  });

  it('validates bundled PNG icon magic bytes and non-zero dimensions directly from ZIP archive', () => {
    const zipBuffer = fs.readFileSync(zipPath);
    const iconSizes = [16, 32, 48, 128];
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    for (const size of iconSizes) {
      const iconPath = `icons/icon-${size}.png`;
      const buf = readZipFileContent(zipBuffer, iconPath);
      expect(buf.subarray(0, 8)).toEqual(pngMagic);

      // Verify IHDR width and height
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      expect(width).toBe(size);
      expect(height).toBe(size);
    }
  });

  it('executes packageExtension and returns comprehensive package summary', () => {
    const summary = packageExtension({ skipBuild: true });
    expect(summary.version).toBe(version);
    expect(summary.versionedZipName).toBe(`lamanisync-extension-v${version}.zip`);
    expect(summary.canonicalZipName).toBe('lamanisync-extension.zip');
    expect(summary.sizeBytes).toBeGreaterThan(10 * 1024);
    expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.fileCount).toBeGreaterThanOrEqual(13);
    expect(summary.files).toContain('manifest.json');
  });

  it('guarantees byte-for-byte deterministic ZIP generation', () => {
    const dummyFiles = [
      { path: 'manifest.json', data: Buffer.from('{"version":"1.0.0"}') },
      { path: 'icons/icon-16.png', data: Buffer.from('png-bytes-16') },
      { path: 'assets/app.js', data: Buffer.from('console.log("hello");') },
    ];

    const zip1 = createDeterministicZip(dummyFiles);
    const zip2 = createDeterministicZip(dummyFiles);

    const hash1 = crypto.createHash('sha256').update(zip1).digest('hex');
    const hash2 = crypto.createHash('sha256').update(zip2).digest('hex');

    expect(hash1).toBe(hash2);
    expect(zip1.equals(zip2)).toBe(true);

    const parsedEntries = readZipEntries(zip1);
    expect(parsedEntries.map((e) => e.name)).toEqual([
      'assets/app.js',
      'icons/icon-16.png',
      'manifest.json',
    ]);
  });
});
