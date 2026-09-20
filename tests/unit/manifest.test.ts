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

  it('must strictly have zero host permissions and zero permissions in Phase 1', () => {
    const raw = manifest as unknown as Record<string, unknown>;
    expect(raw.permissions).toBeUndefined();
    expect(raw.host_permissions).toBeUndefined();
    expect(raw.optional_host_permissions).toBeUndefined();
  });
});
