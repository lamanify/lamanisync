import crypto from 'node:crypto';

// Deterministic test Ed25519 keypair for mock signing
// In production, LamaniHub signs manifests with a secure KMS.
// In test harness, we use this known test keypair.

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export const TEST_PUBLIC_KEY = publicKey;
export const TEST_PRIVATE_KEY = privateKey;

export function signManifest(manifestPayload) {
  // Omit signature field if present to create canonical signing content
  const canonical = { ...manifestPayload };
  delete canonical.signature;
  const data = Buffer.from(JSON.stringify(canonical));
  const signature = crypto.sign(null, data, TEST_PRIVATE_KEY);
  return signature.toString('base64');
}

export function verifyManifestSignature(manifestPayload, signatureBase64, publicKeyPem = TEST_PUBLIC_KEY) {
  const canonical = { ...manifestPayload };
  delete canonical.signature;
  const data = Buffer.from(JSON.stringify(canonical));
  return crypto.verify(null, data, publicKeyPem, Buffer.from(signatureBase64, 'base64'));
}
