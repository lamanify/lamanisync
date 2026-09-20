// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateAdapterManifest } from '../../src/adapters/schema.js';

describe('AdapterManifestSchema & validateAdapterManifest', () => {
  const fixturePath = path.resolve('test-harness/fixtures/adapter-manifest.json');
  const validFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  it('validates canonical adapter manifest fixture successfully', () => {
    const validated = validateAdapterManifest(validFixture);
    expect(validated.adapterId).toBe('acme-cloud-v1');
    expect(validated.targetOrigin).toBe('http://localhost:4001');
    expect(validated.capabilities).toContain('PATIENT_READ');
    expect(validated.endpoints?.patients?.list).toBe('/api/patients');
  });

  it('rejects manifests injecting unknown primitives or capabilities', () => {
    const tampered = {
      ...validFixture,
      capabilities: [...validFixture.capabilities, '__UNKNOWN_DANGEROUS_EVAL__'],
    };

    expect(() => validateAdapterManifest(tampered)).toThrow();
  });

  it('rejects manifests missing required schema fields', () => {
    const missingOrigin = { ...validFixture };
    delete missingOrigin.targetOrigin;
    expect(() => validateAdapterManifest(missingOrigin)).toThrow();

    const missingId = { ...validFixture };
    delete missingId.adapterId;
    expect(() => validateAdapterManifest(missingId)).toThrow();
  });

  it('strictly validates targetOrigin (rejects wildcards, paths, or non-http/https)', () => {
    // Wildcard origin
    expect(() =>
      validateAdapterManifest({ ...validFixture, targetOrigin: 'https://*.example.com' })
    ).toThrow();

    // Origin with path suffix
    expect(() =>
      validateAdapterManifest({ ...validFixture, targetOrigin: 'http://localhost:4001/api' })
    ).toThrow();

    // Origin with query params
    expect(() =>
      validateAdapterManifest({ ...validFixture, targetOrigin: 'http://localhost:4001?foo=bar' })
    ).toThrow();

    // Non http/https scheme
    expect(() =>
      validateAdapterManifest({ ...validFixture, targetOrigin: 'ftp://localhost:4001' })
    ).toThrow();

    // Embedded user credentials
    expect(() =>
      validateAdapterManifest({ ...validFixture, targetOrigin: 'http://admin:secret@localhost:4001' })
    ).toThrow();
  });

  it('rejects dangerous URI schemes, protocol-relative prefixes, and path traversals in endpoints', () => {
    // javascript: URI scheme
    expect(() =>
      validateAdapterManifest({
        ...validFixture,
        endpoints: { ...validFixture.endpoints, patients: { list: 'javascript:alert(1)' } },
      })
    ).toThrow();

    // Protocol-relative origin escape
    expect(() =>
      validateAdapterManifest({
        ...validFixture,
        endpoints: { ...validFixture.endpoints, patients: { list: '//attacker.com/exfiltrate' } },
      })
    ).toThrow();

    // Path traversal
    expect(() =>
      validateAdapterManifest({
        ...validFixture,
        endpoints: { ...validFixture.endpoints, patients: { list: '/api/patients/../../etc/passwd' } },
      })
    ).toThrow();

    // Backslash tricks
    expect(() =>
      validateAdapterManifest({
        ...validFixture,
        endpoints: { ...validFixture.endpoints, patients: { list: '/api\\evil' } },
      })
    ).toThrow();
  });

  it('enforces reasonable polling interval bounds', () => {
    const tooFast = {
      ...validFixture,
      polling: { intervalSeconds: 1 }, // below minimum 5 seconds
    };
    expect(() => validateAdapterManifest(tooFast)).toThrow();
  });
});
