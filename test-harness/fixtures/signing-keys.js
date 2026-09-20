import crypto from 'node:crypto';

// Deterministic test Ed25519 keypair for mock signing
// In production, LamaniHub signs manifests with a secure KMS.
// In test harness, we use this known test keypair.

export const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXLNVk8YJOsPppXxjhsniX4fMUhLBb7vWOcTCBGllkIU=
-----END PUBLIC KEY-----
`;

export const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOZTL4lFHlu+3c2A9pgFzapZ1rq23kNSjZU4kwBfZMS+
-----END PRIVATE KEY-----
`;

export function canonicalJsonStringify(obj) {
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
  const keys = Object.keys(obj).sort();
  const pairs = keys
    .filter(
      (k) =>
        k !== 'signature' &&
        obj[k] !== undefined &&
        typeof obj[k] !== 'function' &&
        typeof obj[k] !== 'symbol'
    )
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

export function signManifest(manifestPayload) {
  const data = Buffer.from(canonicalJsonStringify(manifestPayload));
  const signature = crypto.sign(null, data, TEST_PRIVATE_KEY);
  return signature.toString('base64');
}

export function verifyManifestSignature(manifestPayload, signatureBase64, publicKeyPem = TEST_PUBLIC_KEY) {
  const data = Buffer.from(canonicalJsonStringify(manifestPayload));
  return crypto.verify(null, data, publicKeyPem, Buffer.from(signatureBase64, 'base64'));
}
