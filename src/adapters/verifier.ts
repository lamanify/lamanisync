/**
 * Cryptographic Signature Verifier (Phase 6)
 * Verifies Ed25519 signatures on downloaded adapter manifests using pinned public keys.
 * Strictly adheres to AGENTS.md:
 * Rule 1: Build Manifest V3 only.
 * Rule 2: Never use eval, new Function, remote JavaScript, dynamic remote imports, or arbitrary remote expressions.
 * Rule 9: Validate every message and remote manifest at runtime.
 */

import { LamaniError } from '../core/errors.js';

// Pinned Ed25519 SPKI Public Key for Mock & Development
export const DEFAULT_PINNED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXLNVk8YJOsPppXxjhsniX4fMUhLBb7vWOcTCBGllkIU=
-----END PUBLIC KEY-----
`;

export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(clean)) {
    throw new LamaniError('Invalid base64 characters in payload', 'INVALID_BASE64');
  }
  const stdBase64 = clean.replace(/-/g, '+').replace(/_/g, '/');
  const padded = stdBase64.padEnd(stdBase64.length + ((4 - (stdBase64.length % 4)) % 4), '=');

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function pemToSpkiBytes(pem: string): Uint8Array {
  const header = '-----BEGIN PUBLIC KEY-----';
  const footer = '-----END PUBLIC KEY-----';
  let body = pem.trim();
  const startIdx = body.indexOf(header);
  if (startIdx !== -1) {
    const endIdx = body.indexOf(footer);
    if (endIdx !== -1) {
      body = body.substring(startIdx + header.length, endIdx);
    }
  }
  return base64ToUint8Array(body);
}

const keyCache = new Map<string, CryptoKey>();

export async function getOrImportKey(pemOrBase64: string): Promise<CryptoKey> {
  const cached = keyCache.get(pemOrBase64);
  if (cached) return cached;

  const spkiBytes = pemToSpkiBytes(pemOrBase64);
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.subtle) {
    throw new LamaniError('WebCrypto SubtleCrypto is not available in this execution environment', 'CRYPTO_UNAVAILABLE');
  }

  const key = await webCrypto.subtle.importKey(
    'spki',
    spkiBytes as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  keyCache.set(pemOrBase64, key);
  return key;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return (
      '[' +
      obj
        .map((item) =>
          item === undefined || typeof item === 'function' || typeof item === 'symbol'
            ? 'null'
            : canonicalJsonStringify(item)
        )
        .join(',') +
      ']'
    );
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs = keys
    .filter(
      (k) =>
        k !== 'signature' &&
        record[k] !== undefined &&
        typeof record[k] !== 'function' &&
        typeof record[k] !== 'symbol'
    )
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(record[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Verifies that the manifest payload is cryptographically signed with Ed25519
 * matching the pinned public key.
 */
export async function verifyManifestSignature(
  manifest: unknown,
  pinnedPublicKey: string = DEFAULT_PINNED_PUBLIC_KEY
): Promise<VerificationResult> {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, error: 'MANIFEST_INVALID_PAYLOAD' };
  }

  const record = manifest as Record<string, unknown>;
  const signature = record.signature;

  if (typeof signature !== 'string' || !signature.trim()) {
    return { valid: false, error: 'MANIFEST_UNSIGNED' };
  }

  try {
    const sigBytes = base64ToUint8Array(signature);
    if (sigBytes.length !== 64) {
      return { valid: false, error: 'INVALID_SIGNATURE_LENGTH' };
    }

    const canonicalStr = canonicalJsonStringify(record);
    const canonicalBytes = new TextEncoder().encode(canonicalStr);

    const key = await getOrImportKey(pinnedPublicKey);
    const isValid = await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      sigBytes as BufferSource,
      canonicalBytes as BufferSource
    );

    if (!isValid) {
      return { valid: false, error: 'SIGNATURE_MISMATCH' };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: (err as Error).message || 'VERIFICATION_ERROR' };
  }
}

export async function verifyManifest(
  manifest: unknown,
  pinnedKey: string = DEFAULT_PINNED_PUBLIC_KEY
): Promise<boolean> {
  const result = await verifyManifestSignature(manifest, pinnedKey);
  return result.valid;
}

export async function verifyManifestStrict(
  manifest: unknown,
  pinnedKey: string = DEFAULT_PINNED_PUBLIC_KEY
): Promise<void> {
  const result = await verifyManifestSignature(manifest, pinnedKey);
  if (!result.valid) {
    const isUnsigned = result.error === 'MANIFEST_UNSIGNED';
    throw new LamaniError(
      `Manifest signature verification failed: ${result.error}`,
      isUnsigned ? 'MANIFEST_UNSIGNED' : 'MANIFEST_SIGNATURE_INVALID',
      { isRetryable: false, details: { error: result.error } }
    );
  }
}
