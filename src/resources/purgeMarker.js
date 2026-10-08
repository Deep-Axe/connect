// The obligation to delete private data must survive a page replacement.
// This marker contains no private data. Unreadable storage fails closed.
export function createPurgeMarker(cacheName, storage) {
  const key = `connect:cache-purge:${cacheName}`;
  const persistent = () => storage ?? globalThis.localStorage;
  return {
    pending() {
      try { return persistent().getItem(key) === '1'; } catch { return true; }
    },
    mark() {
      try { persistent().setItem(key, '1'); return true; } catch { return false; }
    },
    complete() {
      try { persistent().removeItem(key); return true; } catch { return false; }
    },
  };
}
