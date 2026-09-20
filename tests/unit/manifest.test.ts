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

  it('strictly adheres to Phase 4 permissions: storage declared, zero broad static host permissions', () => {
    const raw = manifest as unknown as Record<string, unknown>;
    // Storage permission required for session & connection persistence
    expect(raw.permissions).toEqual(['storage']);
    // Static host_permissions must remain strictly undefined (AGENTS.md Rule 3)
    expect(raw.host_permissions).toBeUndefined();
    // Runtime exact origin requests are supported via optional_host_permissions
    expect(raw.optional_host_permissions).toBeDefined();
    expect(Array.isArray(raw.optional_host_permissions)).toBe(true);
  });
});
