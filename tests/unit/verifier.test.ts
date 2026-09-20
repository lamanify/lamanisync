// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  verifyManifestSignature,
  verifyManifest,
  verifyManifestStrict,
  DEFAULT_PINNED_PUBLIC_KEY,
  base64ToUint8Array,
  pemToSpkiBytes,
} from '../../src/adapters/verifier.js';
import { LamaniError } from '../../src/core/errors.js';

describe('Ed25519 Cryptographic Verifier (verifier.ts)', () => {
  const fixturePath = path.resolve('src/adapters/manifests/acme-cloud.json');
  const validManifest = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  it('successfully verifies a valid signed manifest using pinned public key', async () => {
    const result = await verifyManifestSignature(validManifest);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();

    const boolResult = await verifyManifest(validManifest);
    expect(boolResult).toBe(true);

    await expect(verifyManifestStrict(validManifest)).resolves.not.toThrow();
  });

  it('rejects unsigned manifest payloads with MANIFEST_UNSIGNED', async () => {
    const unsigned = { ...validManifest };
    delete unsigned.signature;

    const result = await verifyManifestSignature(unsigned);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('MANIFEST_UNSIGNED');

    await expect(verifyManifestStrict(unsigned)).rejects.toThrowError(LamaniError);
    await expect(verifyManifestStrict(unsigned)).rejects.toMatchObject({
      code: 'MANIFEST_UNSIGNED',
    });
  });

  it('rejects tampered manifest content immediately (fails closed)', async () => {
    // Tamper with version
    const tamperedVersion = {
      ...validManifest,
      version: '9.9.9',
    };
    const res1 = await verifyManifestSignature(tamperedVersion);
    expect(res1.valid).toBe(false);
    expect(res1.error).toBe('SIGNATURE_MISMATCH');

    // Tamper with targetOrigin
    const tamperedOrigin = {
      ...validManifest,
      targetOrigin: 'http://evil.com',
    };
    const res2 = await verifyManifestSignature(tamperedOrigin);
    expect(res2.valid).toBe(false);
    expect(res2.error).toBe('SIGNATURE_MISMATCH');

    await expect(verifyManifestStrict(tamperedVersion)).rejects.toMatchObject({
      code: 'MANIFEST_SIGNATURE_INVALID',
    });
  });

  it('rejects corrupted or invalid base64 signatures', async () => {
    const corruptedSig = {
      ...validManifest,
      signature: 'this_is_not_valid_ed25519_base64_signature_tampered',
    };
    const result = await verifyManifestSignature(corruptedSig);
    expect(result.valid).toBe(false);

    const wrongLengthSig = {
      ...validManifest,
      signature: Buffer.from('too-short').toString('base64'),
    };
    const resWrongLength = await verifyManifestSignature(wrongLengthSig);
    expect(resWrongLength.valid).toBe(false);
    expect(resWrongLength.error).toBe('INVALID_SIGNATURE_LENGTH');
  });

  it('rejects manifests signed by an unpinned foreign key', async () => {
    // Other foreign Ed25519 public key
    const foreignPublicKey = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi4m2eH99t/gW97B8ZJ2xK8dM3hS9w6Jq+v1l7yQ7Q7A=
-----END PUBLIC KEY-----`;

    const result = await verifyManifestSignature(validManifest, foreignPublicKey);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('SIGNATURE_MISMATCH');
  });

  it('correctly converts base64 to Uint8Array and extracts SPKI bytes from PEM', () => {
    const b64 = Buffer.from('hello-ed25519').toString('base64');
    const bytes = base64ToUint8Array(b64);
    expect(Buffer.from(bytes).toString('utf-8')).toBe('hello-ed25519');

    const spki = pemToSpkiBytes(DEFAULT_PINNED_PUBLIC_KEY);
    expect(spki.length).toBeGreaterThan(0);
  });

  it('canonicalJsonStringify cleanly handles undefined properties, functions, and arrays with holes', async () => {
    const { canonicalJsonStringify } = await import('../../src/adapters/verifier.js');
    const resultObj = canonicalJsonStringify({ a: 1, b: undefined, c: () => {} });
    expect(resultObj).toBe('{"a":1}');

    const resultArr = canonicalJsonStringify([1, undefined, 2]);
    expect(resultArr).toBe('[1,null,2]');
  });

  it('base64ToUint8Array correctly converts URL-safe base64 and rejects invalid characters', () => {
    // Standard: SGVsbG8=
    // URL safe with - and _
    const urlSafe = 'SGVsbG8-_w';
    expect(() => base64ToUint8Array(urlSafe)).not.toThrow();

    // Invalid non-base64 characters
    expect(() => base64ToUint8Array('Invalid base64 with spaces!')).toThrowError(LamaniError);
  });
});
