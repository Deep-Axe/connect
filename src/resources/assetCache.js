import { createPurgeMarker } from './purgeMarker';

// Connections and clear barriers belong to a store. Expiry is checked on
// every read; all three stores are swept together when the database opens.
const STORES = ['events', 'coords', 'driveCoords'];

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Cache transaction failed'));
  });
}

export function createAssetCache(indexedDB = globalThis.indexedDB, marker = createPurgeMarker('assets')) {
  let database;
  let generation = 0;
  let barrier = Promise.resolve();
  let purgePending = marker.pending();
  const expired = record => !Number.isFinite(record?.expiry) || record.expiry <= Math.floor(Date.now() / 1000);
  const open = () => {
    if (!indexedDB) return Promise.resolve(null);
    if (!database) database = new Promise((resolve) => {
      let settled = false;
      const finish = (db) => { settled = true; resolve(db); };
      let request;
      try { request = indexedDB.open('cacheDB', 2); } catch { finish(null); return; }
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          if (db.objectStoreNames.contains(name)) continue;
          const store = db.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('expiry', 'expiry');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        if (STORES.some(name => !db.objectStoreNames.contains(name))) { db.close(); finish(null); return; }
        db.onversionchange = () => { db.close(); database = null; };
        // No timer and no first-store flag: prune every store on each open.
        let transaction;
        try { transaction = db.transaction(STORES, 'readwrite'); } catch { db.close(); finish(null); return; }
        for (const name of STORES) {
          const store = transaction.objectStore(name);
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            if (expired(cursor.value)) cursor.delete();
            cursor.continue();
          };
        }
        transactionDone(transaction).then(() => finish(db), () => finish(db));
      };
    }).then((db) => {
      if (!db) database = null; // a temporary open failure may be retried
      return db;
    });
    return database;
  };

  const purge = () => {
    purgePending ||= marker.pending();
    if (!purgePending) return barrier;
    barrier = barrier.then(async () => {
      if (!purgePending) return;
      const db = await open();
      if (!db) return; // keep the obligation: the next access must retry it
      const transaction = db.transaction(STORES, 'readwrite');
      for (const name of STORES) transaction.objectStore(name).clear();
      await transactionDone(transaction);
      purgePending = !marker.complete();
    }).catch(() => {});
    return barrier;
  };
  const readyDatabase = async () => {
    await purge();
    return purgePending ? null : open();
  };

  return {
    async read(storeName, key, version, isCurrent = () => true) {
      const owner = generation;
      try {
        const db = await readyDatabase();
        if (!db || owner !== generation || !isCurrent()) return null;
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.get(key);
        let value = null;
        request.onsuccess = () => {
          const record = request.result;
          if (!record) return;
          if (expired(record)) {
            store.delete(key);
          } else if ((version === undefined || record.version === version) && owner === generation && isCurrent()) value = record.data;
        };
        await transactionDone(transaction);
        return owner === generation && isCurrent() ? value : null;
      } catch { return null; }
    },

    async write(storeName, key, expiry, data, version, isCurrent = () => true) {
      const owner = generation;
      try {
        const db = await readyDatabase();
        if (!db || owner !== generation || !isCurrent()) return false;
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.get(key);
        request.onsuccess = () => {
          if (owner !== generation || !isCurrent()) return;
          // Compare and put within one transaction so an older version can
          // never replace a newer immutable asset in persistent storage.
          if (version !== undefined && request.result?.version > version) return;
          store.put({ key, expiry, data, version });
        };
        await transactionDone(transaction);
        return owner === generation && isCurrent();
      } catch { return false; }
    },

    clear() {
      generation += 1; // invalidate pending reads/writes before any await
      purgePending = true;
      marker.mark(); // before an await, including an unavailable database
      return purge();
    },
  };
}

export function assetCacheFor(services) {
  services.assetCache ??= createAssetCache();
  return services.assetCache;
}
