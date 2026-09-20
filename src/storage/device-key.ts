/**
 * Device Identity Store (Phase 4)
 * Generates and stores a non-exportable WebCrypto ECDSA (P-256) private key in IndexedDB.
 * Exports only the public key SPKI (base64) for registration with LamaniHub Sync API.
 * Adheres to AGENTS.md Rule 4 (zero secrets/passwords transmitted) and Rule 6 (no raw PHI).
 */

const DB_NAME = 'lamanisync_identity';
const DB_VERSION = 1;
const STORE_NAME = 'device_keys';
const DEVICE_KEY_ID = 'active_device_key';

export interface DeviceKeyRecord {
  id: string;
  privateKey: CryptoKey;
  publicKeySpki: string;
  algorithm: string;
  createdAt: string;
}

export interface DeviceKeyPair {
  privateKey: CryptoKey;
  publicKeySpki: string;
}

let configuredIdbFactory: IDBFactory | null = null;

/**
 * Configure a custom IDBFactory (primarily used in test environments).
 */
export function setIndexedDbFactory(factory: IDBFactory | null): void {
  configuredIdbFactory = factory;
}

function getIdbFactory(): IDBFactory {
  if (configuredIdbFactory) return configuredIdbFactory;
  if (typeof indexedDB !== 'undefined') return indexedDB;
  if (typeof globalThis.indexedDB !== 'undefined') return globalThis.indexedDB;
  throw new Error('IndexedDB is not available in current environment');
}

/**
 * Convert ArrayBuffer / Uint8Array to Base64 string.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Base64 string to Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Opens or initializes the device identity IndexedDB database.
 */
function openDatabase(factory: IDBFactory = getIdbFactory()): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open identity database'));
  });
}

/**
 * Generates an ECDSA (P-256) keypair.
 * The private key is strictly non-exportable (extractable = false).
 * The public key is exported to SPKI Base64 for registration.
 */
async function generateNewDeviceKey(): Promise<DeviceKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    false, // extractable: privateKey is non-exportable
    ['sign', 'verify']
  );

  const spkiBuffer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const publicKeySpki = arrayBufferToBase64(spkiBuffer);

  return {
    privateKey: keyPair.privateKey,
    publicKeySpki,
  };
}

let keyGenPromise: Promise<DeviceKeyPair> | null = null;

/**
 * Retrieves the existing device keypair from IndexedDB or generates and persists a new one.
 * Avoids holding an IndexedDB transaction open across async WebCrypto operations
 * to prevent TransactionInactiveError in compliant browser runtimes.
 */
export async function getOrCreateDeviceKey(factory?: IDBFactory): Promise<DeviceKeyPair> {
  const db = await openDatabase(factory);

  // 1. Check existing record in a readonly transaction
  const existing = await new Promise<DeviceKeyPair | null>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(DEVICE_KEY_ID);

      req.onsuccess = () => {
        const record = req.result as DeviceKeyRecord | undefined;
        if (record && record.privateKey && record.publicKeySpki) {
          resolve({
            privateKey: record.privateKey,
            publicKeySpki: record.publicKeySpki,
          });
        } else {
          resolve(null);
        }
      };

      req.onerror = () => reject(req.error || new Error('Failed to query device key store'));
    } catch (err) {
      reject(err);
    }
  });

  if (existing) {
    return existing;
  }

  // 2. Prevent race conditions with concurrent calls
  if (keyGenPromise) {
    return keyGenPromise;
  }

  keyGenPromise = (async () => {
    try {
      const newKey = await generateNewDeviceKey();
      const newRecord: DeviceKeyRecord = {
        id: DEVICE_KEY_ID,
        privateKey: newKey.privateKey,
        publicKeySpki: newKey.publicKeySpki,
        algorithm: 'ECDSA-P256',
        createdAt: new Date().toISOString(),
      };

      // 3. Persist new key in a dedicated readwrite transaction
      await new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const putReq = store.put(newRecord);

          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error || new Error('Failed to store device key'));
        } catch (err) {
          reject(err);
        }
      });

      return newKey;
    } finally {
      keyGenPromise = null;
    }
  })();

  return keyGenPromise;
}

/**
 * Retrieves the device public key SPKI base64 string if a key already exists.
 */
export async function getDevicePublicKey(factory?: IDBFactory): Promise<string | null> {
  const db = await openDatabase(factory);

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(DEVICE_KEY_ID);

      req.onsuccess = () => {
        const record = req.result as DeviceKeyRecord | undefined;
        resolve(record?.publicKeySpki ?? null);
      };
      req.onerror = () => reject(req.error || new Error('Failed to query public key'));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Signs arbitrary payload with the non-exportable device private key.
 * Payload can be string, ArrayBuffer, Uint8Array, ArrayBufferView, or JSON object.
 * Returns base64-encoded ECDSA SHA-256 signature.
 */
export async function signPayload(
  payload: string | ArrayBuffer | ArrayBufferView | Record<string, unknown>,
  factory?: IDBFactory
): Promise<string> {
  const { privateKey } = await getOrCreateDeviceKey(factory);

  let dataBytes: Uint8Array;
  if (typeof payload === 'string') {
    dataBytes = new TextEncoder().encode(payload);
  } else if (payload instanceof Uint8Array) {
    dataBytes = payload;
  } else if (payload instanceof ArrayBuffer) {
    dataBytes = new Uint8Array(payload);
  } else if (ArrayBuffer.isView(payload)) {
    dataBytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  } else {
    dataBytes = new TextEncoder().encode(JSON.stringify(payload));
  }

  const signatureBuffer = await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    privateKey,
    dataBytes as unknown as BufferSource
  );

  return arrayBufferToBase64(signatureBuffer);
}

/**
 * Purges the active device key from IndexedDB upon unpairing or revocation.
 */
export async function purgeDeviceKey(factory?: IDBFactory): Promise<void> {
  const db = await openDatabase(factory);

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(DEVICE_KEY_ID);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to purge device key'));
    } catch (err) {
      reject(err);
    }
  });
}
