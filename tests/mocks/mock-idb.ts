/**
 * Lightweight in-memory IDBFactory mock for unit testing WebCrypto key storage.
 * Conforms to standard IDB interfaces without external dependencies.
 */

interface MockRequestInternal {
  result: unknown;
  error: DOMException | null;
  onsuccess: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  readyState: IDBRequestReadyState;
}

export class MockIDBObjectStore {
  private data: Map<IDBValidKey, unknown>;
  readonly name: string;
  readonly keyPath: string;

  constructor(name: string, keyPath: string, initialData?: Map<IDBValidKey, unknown>) {
    this.name = name;
    this.keyPath = keyPath;
    this.data = initialData ?? new Map();
  }

  get(key: IDBValidKey): IDBRequest {
    const req = createMockRequest();
    queueMicrotask(() => {
      req.result = this.data.get(key);
      if (typeof req.onsuccess === 'function') {
        req.onsuccess({ target: req } as unknown as Event);
      }
    });
    return req as unknown as IDBRequest;
  }

  put(value: unknown): IDBRequest {
    const req = createMockRequest();
    const key = (value as Record<string, IDBValidKey>)[this.keyPath];
    this.data.set(key, value);
    queueMicrotask(() => {
      req.result = key;
      if (typeof req.onsuccess === 'function') {
        req.onsuccess({ target: req } as unknown as Event);
      }
    });
    return req as unknown as IDBRequest;
  }

  delete(key: IDBValidKey): IDBRequest {
    const req = createMockRequest();
    this.data.delete(key);
    queueMicrotask(() => {
      req.result = undefined;
      if (typeof req.onsuccess === 'function') {
        req.onsuccess({ target: req } as unknown as Event);
      }
    });
    return req as unknown as IDBRequest;
  }
}

export class MockIDBTransaction {
  readonly db: MockIDBDatabase;
  readonly mode: IDBTransactionMode;
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(db: MockIDBDatabase, mode: IDBTransactionMode) {
    this.db = db;
    this.mode = mode;
    queueMicrotask(() => {
      if (this.oncomplete) {
        this.oncomplete(new Event('complete'));
      }
    });
  }

  objectStore(name: string): IDBObjectStore {
    const store = this.db._getStore(name);
    if (!store) {
      throw new Error(`NotFoundError: Object store "${name}" not found`);
    }
    return store as unknown as IDBObjectStore;
  }
}

export class MockIDBDatabase {
  readonly name: string;
  readonly version: number;
  private stores: Map<string, MockIDBObjectStore> = new Map();
  objectStoreNames: DOMStringList;

  constructor(name: string, version: number) {
    this.name = name;
    this.version = version;
    const storeMap = this.stores;
    this.objectStoreNames = {
      contains: (s: string) => storeMap.has(s),
      item: (index: number) => Array.from(storeMap.keys())[index] ?? null,
      length: 0,
      [Symbol.iterator]: () => storeMap.keys(),
    } as unknown as DOMStringList;
  }

  createObjectStore(name: string, options?: IDBObjectStoreParameters): IDBObjectStore {
    const store = new MockIDBObjectStore(name, (options?.keyPath as string) ?? 'id');
    this.stores.set(name, store);
    return store as unknown as IDBObjectStore;
  }

  transaction(_storeNames: string | string[], mode: IDBTransactionMode = 'readonly'): IDBTransaction {
    return new MockIDBTransaction(this, mode) as unknown as IDBTransaction;
  }

  _getStore(name: string): MockIDBObjectStore | undefined {
    return this.stores.get(name);
  }

  close(): void {
    // no-op
  }
}

function createMockRequest(): MockRequestInternal {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    readyState: 'pending',
  };
}

export class MockIDBFactory {
  private databases: Map<string, MockIDBDatabase> = new Map();

  open(name: string, version: number = 1): IDBOpenDBRequest {
    const req = createMockRequest();
    let db = this.databases.get(name);
    const isNew = !db;

    if (!db) {
      db = new MockIDBDatabase(name, version);
      this.databases.set(name, db);
    }

    queueMicrotask(() => {
      req.result = db;
      if (isNew && (req as unknown as IDBOpenDBRequest).onupgradeneeded) {
        ((req as unknown as IDBOpenDBRequest).onupgradeneeded as (e: Event) => void)({
          target: req,
          oldVersion: 0,
          newVersion: version,
        } as unknown as Event);
      }
      if (typeof req.onsuccess === 'function') {
        req.onsuccess({ target: req } as unknown as Event);
      }
    });

    return req as unknown as IDBOpenDBRequest;
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    const req = createMockRequest();
    this.databases.delete(name);
    queueMicrotask(() => {
      if (typeof req.onsuccess === 'function') {
        req.onsuccess({ target: req } as unknown as Event);
      }
    });
    return req as unknown as IDBOpenDBRequest;
  }
}

export function createMockIDBFactory(): IDBFactory {
  return new MockIDBFactory() as unknown as IDBFactory;
}
