// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateAdapterManifest } from '../../src/adapters/schema.js';
import { verifyManifestSignature } from '../../src/adapters/verifier.js';

describe('LamaniPulse Adapter Manifest Verification', () => {
  const manifestPath = path.resolve('src/adapters/manifests/lamanipulse.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  it('validates LamaniPulse manifest against schema', () => {
    const validated = validateAdapterManifest(manifest);
    expect(validated.adapterId).toBe('lamanipulse-v1');
    expect(validated.targetOrigin).toBe('https://app.lamanipulse.com');
    expect(validated.capabilities).toContain('PATIENT_READ');
    expect(validated.capabilities).toContain('PATIENT_WRITE');
    expect(validated.capabilities).toContain('APPOINTMENT_READ');
    expect(validated.capabilities).toContain('APPOINTMENT_WRITE');
    expect(validated.capabilities).toContain('REFERENCE_DATA_READ');
    expect(validated.endpoints?.patients?.list).toBe('/rest/v1/patients');
    expect(validated.endpoints?.appointments?.list).toBe('/rest/v1/appointments');
  });

  it('verifies Ed25519 cryptographic signature against pinned public key', async () => {
    const result = await verifyManifestSignature(manifest);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
