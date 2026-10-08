import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetCache } from './assetCache';

beforeEach(() => localStorage.clear());

// A serial transaction fake, including requests queued from request handlers.
// It exercises the compare/put and logout barriers without browser storage.

function memoryDatabase(seed = {}) {
  const records = Object.fromEntries(['events', 'coords', 'driveCoords'].map(name => [name, new Map(seed[name] || [])]));
  let queue = Promise.resolve();
  const db = {
    objectStoreNames: {
      contains: name => Boolean(records[name])
    },
    close() {},
    transaction() {
      const transaction = {
        pending: [],
        objectStore: name => {
          const map = records[name];
          const request = operation => {
            const result = {};
            transaction.pending.push(() => {
              result.result = operation();
              result.onsuccess?.();
            });
            return result;
          };
          return {
            get: key => request(() => map.get(JSON.stringify(key))),
            put: value => request(() => map.set(JSON.stringify(value.key), value)),
            delete: key => request(() => map.delete(JSON.stringify(key))),
            clear: () => request(() => map.clear()),
            openCursor: () => {
              const cursorRequest = {};
              const entries = [...map.entries()];
              const advance = () => transaction.pending.push(() => {
                const entry = entries.shift();
                cursorRequest.result = entry && {
                  value: entry[1],
                  delete: () => map.delete(entry[0]),
                  continue: advance
                };
                cursorRequest.onsuccess?.();
              });
              advance();
              return cursorRequest;
            }
          };
        }
      };
      queue = queue.then(async () => {
        await Promise.resolve();
        while (transaction.pending.length) transaction.pending.shift()();
        transaction.oncomplete?.();
      });
      return transaction;
    }
  };
  return {
    records,
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = db;
          request.onsuccess();
        });
        return request;
      }
    }
  };
}

describe('persistent asset lifecycle', () => {
  it('prunes expiry in all stores on open and rejects expiry on every read', async () => {
    const expired = {
      key: 'expired',
      expiry: 1,
      data: 'old'
    };
    const memory = memoryDatabase(Object.fromEntries(['events', 'coords', 'driveCoords'].map(name => [name, [[JSON.stringify('expired'), expired]]])));
    const cache = createAssetCache(memory.indexedDB);
    expect(await cache.read('coords', 'expired')).toBeNull();
    Object.values(memory.records).forEach(store => expect(store.size).toBe(0));
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await cache.write('events', 'route', 20, [], 2);
    expect(await cache.read('events', 'route', 2)).toEqual([]);
    vi.setSystemTime(20_000);
    expect(await cache.read('events', 'route', 2)).toBeNull();
    vi.useRealTimers();
  });

  it('compares versions atomically and requires the exact requested version', async () => {
    const memory = memoryDatabase();
    const cache = createAssetCache(memory.indexedDB);
    await Promise.all([cache.write('events', 'route', 1e12, 'new', 2), cache.write('events', 'route', 1e12, 'old', 1)]);
    expect(await cache.read('events', 'route', 2)).toBe('new');
    expect(await cache.read('events', 'route', 1)).toBeNull();
    expect(await cache.read('events', 'route', 2)).toBe('new');
  });

  it('logout clears every store and invalidates pending old writes before opening', async () => {
    const memory = memoryDatabase();
    const cache = createAssetCache(memory.indexedDB);
    const pending = cache.write('events', 'old', 1e12, 'secret', 1);
    await cache.clear();
    await pending;
    expect(await cache.read('events', 'old', 1)).toBeNull();
    await Promise.all(['events', 'coords', 'driveCoords'].map(name => cache.write(name, 'new', 1e12, 'new', 2)));
    await cache.clear();
    Object.values(memory.records).forEach(store => expect(store.size).toBe(0));
    await cache.write('events', 'fresh-session', 1e12, 'fresh', 1);
    expect(await cache.read('events', 'fresh-session', 1)).toBe('fresh');
  });

  it('storage failures and unavailable storage do not block retryable network work', async () => {
    const deniedOpen = vi.fn(() => {
      throw new Error('storage denied');
    });
    const cache = createAssetCache({
      open: deniedOpen
    });
    expect(await cache.read('events', 'route', 1)).toBeNull();
    expect(await cache.write('events', 'route', 1e12, [], 1)).toBe(false);
    expect(deniedOpen).toHaveBeenCalledTimes(2);
    await cache.clear();
    expect(await createAssetCache(null).read('events', 'route', 1)).toBeNull();
  });

  it('a failed logout open retains the purge obligation before the next session can read', async () => {
    const memory = memoryDatabase({
      events: [[JSON.stringify('secret'), {
        key: 'secret',
        expiry: 1e12,
        version: 1,
        data: 'old user'
      }]]
    });
    const open = vi.fn().mockImplementationOnce(() => {
      throw new Error('temporarily unavailable');
    }).mockImplementation(() => memory.indexedDB.open());
    const cache = createAssetCache({
      open
    });
    await cache.clear();
    expect(memory.records.events.size).toBe(1);
    expect(await cache.read('events', 'secret', 1)).toBeNull();
    expect(memory.records.events.size).toBe(0);
    await cache.write('events', 'fresh', 1e12, 'new user', 1);
    expect(await cache.read('events', 'fresh', 1)).toBe('new user');
  });

  it('missing or nonfinite expiry cannot create immortal cache entries', async () => {
    const memory = memoryDatabase({
      events: [['"missing"', {
        key: 'missing',
        data: 'secret'
      }]],
      coords: [['"invalid"', {
        key: 'invalid',
        expiry: Infinity,
        data: 'secret'
      }]]
    });
    const cache = createAssetCache(memory.indexedDB);
    expect(await cache.read('events', 'missing')).toBeNull();
    expect(await cache.read('coords', 'invalid')).toBeNull();
    expect(memory.records.events.size + memory.records.coords.size).toBe(0);
  });

  it('a new cache instance after reload purges a prior logout whose database open failed', async () => {
    const memory = memoryDatabase({
      events: [['"public-route"', {
        key: 'public-route',
        expiry: 1e12,
        version: 1,
        data: 'old private events'
      }]]
    });
    const oldPage = createAssetCache({
      open() {
        throw new Error('blocked');
      }
    });
    await oldPage.clear();
    expect(localStorage.getItem('connect:cache-purge:assets')).toBe('1');
    expect(memory.records.events.size).toBe(1);
    const nextPage = createAssetCache(memory.indexedDB);
    expect(await nextPage.read('events', 'public-route', 1)).toBeNull();
    expect(memory.records.events.size).toBe(0);
    expect(localStorage.getItem('connect:cache-purge:assets')).toBeNull();
  });
});
