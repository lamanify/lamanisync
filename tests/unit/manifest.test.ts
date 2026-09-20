// @vitest-environment node
import { describe, it, expect } from 'vitest';
import rawManifest from '../../manifest.config';

const manifest = rawManifest as chrome.runtime.ManifestV3;

describe('Manifest V3 Configuration', () => {
  it('should conform to Manifest V3 specification', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('should declare name and valid semver version', () => {
    expect(manifest.name).toBe('LamaniSync Dev');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should declare default popup and background service worker', () => {
    expect(manifest.action?.default_popup).toBe('popup.html');
    expect(manifest.background?.service_worker).toBe('src/background/service-worker.ts');
    expect(manifest.background?.type).toBe('module');
  });

  it('strictly adheres to Phase 5 permissions: storage and scripting declared, zero broad static host permissions', () => {
    const raw = manifest as unknown as Record<string, unknown>;
    // Storage and scripting permissions required for session persistence and dynamic script registration
    expect(raw.permissions).toEqual(['storage', 'scripting']);
    // Static host_permissions must remain strictly undefined (AGENTS.md Rule 3)
    expect(raw.host_permissions).toBeUndefined();
    // Runtime exact origin requests are supported via optional_host_permissions
    expect(raw.optional_host_permissions).toBeDefined();
    expect(Array.isArray(raw.optional_host_permissions)).toBe(true);
  });

  it('builds standalone IIFE classic scripts without module imports or chunk splitting', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const csPath = path.resolve('dist/content-script.js');
    const pwPath = path.resolve('dist/page-world.js');

    if (fs.existsSync(csPath) && fs.existsSync(pwPath)) {
      const cs = fs.readFileSync(csPath, 'utf8');
      const pw = fs.readFileSync(pwPath, 'utf8');

      // Top-level ESM imports strictly prohibited in classic content scripts
      expect(/\bimport\s+/.test(cs)).toBe(false);
      expect(/\bimport\s+/.test(pw)).toBe(false);

      // Must parse cleanly as classic scripts
      expect(() => new Function(cs)).not.toThrow();
      expect(() => new Function(pw)).not.toThrow();
    }
  });
});
