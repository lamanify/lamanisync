// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateDeviceKey,
  getDevicePublicKey,
  signPayload,
  purgeDeviceKey,
  setIndexedDbFactory,
  base64ToUint8Array,
} from '../../src/storage/device-key.js';
import { createMockIDBFactory } from '../mocks/mock-idb.js';

describe('Device Identity Store (WebCrypto ECDSA P-256)', () => {
  let mockIdb: IDBFactory;

  beforeEach(() => {
    mockIdb = createMockIDBFactory();
    setIndexedDbFactory(mockIdb);
  });

  it('generates a non-exportable private key and exportable public key SPKI', async () => {
    const keyPair = await getOrCreateDeviceKey();

    expect(keyPair.privateKey).toBeDefined();
    expect(keyPair.privateKey.type).toBe('private');
    // Private key must be strictly non-exportable
    expect(keyPair.privateKey.extractable).toBe(false);
    expect(keyPair.publicKeySpki).toBeDefined();
    expect(typeof keyPair.publicKeySpki).toBe('string');
    expect(keyPair.publicKeySpki.length).toBeGreaterThan(50);
  });

  it('retrieves previously stored key without generating a new one', async () => {
    const first = await getOrCreateDeviceKey();
    const second = await getOrCreateDeviceKey();

    expect(second.publicKeySpki).toBe(first.publicKeySpki);
    const pubKey = await getDevicePublicKey();
    expect(pubKey).toBe(first.publicKeySpki);
  });

  it('signs payload and signature is cryptographically verifiable with public key', async () => {
    const keyPair = await getOrCreateDeviceKey();
    const payload = 'test-pairing-handshake-nonce-123';

    const signatureBase64 = await signPayload(payload);
    expect(signatureBase64).toBeDefined();
    expect(typeof signatureBase64).toBe('string');

    // Verify signature using imported public key
    const publicKeyBytes = base64ToUint8Array(keyPair.publicKeySpki);
    const importedPublicKey = await crypto.subtle.importKey(
      'spki',
      publicKeyBytes as unknown as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );

    const sigBytes = base64ToUint8Array(signatureBase64);
    const dataBytes = new TextEncoder().encode(payload);

    const isValid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      importedPublicKey,
      sigBytes as unknown as BufferSource,
      dataBytes as unknown as BufferSource
    );

    expect(isValid).toBe(true);

    // Verify different data fails verification
    const isTamperedValid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      importedPublicKey,
      sigBytes as unknown as BufferSource,
      new TextEncoder().encode('tampered-payload') as unknown as BufferSource
    );
    expect(isTamperedValid).toBe(false);
  });

  it('supports signing objects and Uint8Array payloads', async () => {
    const objectPayload = { command: 'PAIR', timestamp: 123456 };
    const sig1 = await signPayload(objectPayload);
    expect(typeof sig1).toBe('string');

    const bytesPayload = new Uint8Array([1, 2, 3, 4, 5]);
    const sig2 = await signPayload(bytesPayload);
    expect(typeof sig2).toBe('string');
  });

  it('purges device key on unpair / revocation', async () => {
    const keyPair1 = await getOrCreateDeviceKey();
    expect(keyPair1.publicKeySpki).toBeDefined();

    await purgeDeviceKey();

    const storedPub = await getDevicePublicKey();
    expect(storedPub).toBeNull();

    // Next getOrCreateDeviceKey will generate a new keypair
    const keyPair2 = await getOrCreateDeviceKey();
    expect(keyPair2.publicKeySpki).not.toBe(keyPair1.publicKeySpki);
  });

  it('handles concurrent getOrCreateDeviceKey calls without racing or generating duplicate keys', async () => {
    await purgeDeviceKey();

    const [keyA, keyB, keyC] = await Promise.all([
      getOrCreateDeviceKey(),
      getOrCreateDeviceKey(),
      getOrCreateDeviceKey(),
    ]);

    expect(keyA.publicKeySpki).toBe(keyB.publicKeySpki);
    expect(keyB.publicKeySpki).toBe(keyC.publicKeySpki);
  });

  it('supports signing ArrayBuffer and DataView payloads', async () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(0, 0x12345678);

    const sigBuf = await signPayload(buffer);
    expect(typeof sigBuf).toBe('string');

    const sigView = await signPayload(view);
    expect(typeof sigView).toBe('string');
  });
});
