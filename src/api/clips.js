import { athena as Athena } from '../api';
import localforage from 'localforage';
import { deviceVersionAtLeast } from '../utils';
import { createPurgeMarker } from '../resources/purgeMarker';

const CLIP_CHUNK_CONCURRENCY = 3;
const CLIP_RETRY_DELAYS = [500, 1000, 2000, 4000, 8000, 16000];
export class ClipChangedError extends Error {
  constructor() {
    super('This clip changed on the device');
    this.name = 'ClipChangedError';
  }
}

export function createClipService({ storage = localforage.createInstance({ name: 'connect', storeName: 'clip_cache' }), ready = Promise.resolve(), isCurrent = () => true, marker = createPurgeMarker('clips') } = {}) {
  const activeDownloads = new Map();
  const supportRequests = new Map();
  let disposed = false;
  const writes = new Set();
  const objectUrls = new Set();
  let purgePending = marker.pending();
  let storageBarrier = Promise.resolve(ready).then((cleared) => { purgePending ||= cleared === false; }, () => { purgePending = true; });
  function assertActive() {
    if (disposed || !isCurrent()) throw new Error('Clip service disposed');
  }
  async function cacheRead(key) {
    await cacheReady();
    assertActive();
    const value = await storage.getItem(key).catch(() => null);
    assertActive();
    return value;
  }
  function cacheWrite(operation) {
    const pending = cacheReady().then(() => { assertActive(); return operation(); }).catch(() => {});
    writes.add(pending);
    pending.finally(() => writes.delete(pending));
    return pending;
  }
  async function cacheReady() {
    await storageBarrier;
    purgePending ||= marker.pending();
    if (purgePending) {
      storageBarrier = storageBarrier.then(async () => {
        if (!purgePending) return;
        try { await storage.clear(); purgePending = !marker.complete(); } catch { /* keep private bytes quarantined */ }
      });
      await storageBarrier;
      if (purgePending) throw new Error('Clip cache unavailable');
    }
  }

  function supportCacheKey(dongleId) {
    return `clip-support:${dongleId}`;
  }

  function cacheKey(dongleId, filename, requestedAt) {
    return `clip:${dongleId}/${filename}/${requestedAt}`;
  }

  async function invalidateClip(dongleId, filename) {
    const prefix = `clip:${dongleId}/${filename}/`;
    for (const [key, entry] of activeDownloads.entries()) {
      if (key.startsWith(prefix)) {
        entry.cancelled = true;
        entry.waiters.forEach((finish) => finish());
        entry.listeners.clear();
        activeDownloads.delete(key);
      }
    }
    try { await cacheReady(); } catch { assertActive(); return; }
    assertActive();
    const keys = await storage.keys().catch(() => []);
    assertActive();
    await Promise.all(keys.filter(key => key.startsWith(prefix)).map(key => cacheWrite(() => storage.removeItem(key)))).catch(() => {});
  }

  async function downloadClip(dongleId, filename, reportProgress, isCancelled, waitForRetry) {
    const chunks = [];
    let loaded = 0;
    let size;
    let chunkBytes;
    let nextOffset = 0;

    while (size === undefined || nextOffset < size) {
      if (isCancelled()) throw new Error('Clip download cancelled');
      const offsets = Array.from(
        { length: chunkBytes ? Math.min(CLIP_CHUNK_CONCURRENCY, Math.ceil((size - nextOffset) / chunkBytes)) : 1 },
        (_, index) => nextOffset + (index * (chunkBytes || 0)),
      );
      let results;
      try {
        // eslint-disable-next-line no-await-in-loop
        results = await Promise.all(offsets.map(offset => getClipChunk(dongleId, filename, offset, 0, isCancelled, waitForRetry)));
      } catch (error) {
        if (isCancelled()) throw new Error('Clip download cancelled');
        throw error;
      }
      if (isCancelled()) throw new Error('Clip download cancelled');
      for (const result of results) {
        if (size === undefined) size = result.size;
        if (result.size !== size || result.offset !== nextOffset) throw new Error('Clip changed during download');
        const binary = atob(result.data);
        const chunk = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (!chunk.length && nextOffset < size) throw new Error('Clip download returned an empty chunk');
        if (!chunkBytes) chunkBytes = chunk.length;
        chunks.push(chunk);
        loaded += chunk.length;
        nextOffset += chunk.length;
        reportProgress(loaded, size);
      }
    }
    if (loaded !== size) throw new Error(`Clip download ended at ${loaded} of ${size} bytes`);
    return new Blob(chunks, { type: 'video/mp4' });
  }

  // Chunks are addressed by filename only, so a version (requested_at) can only
  // be checked, not pinned: `isCurrentVersion` is asked before downloading and
  // again after, and bytes are cached under a version only once it still holds.
  async function getClipBlob(dongleId, filename, requestedAt, onProgress, isCurrentVersion) {
    assertActive();
    const key = cacheKey(dongleId, filename, requestedAt);
    let entry = activeDownloads.get(key);
    if (!entry) {
      entry = { cancelled: false, listeners: new Set(), consumers: new Set(), waiters: new Set(), loaded: 0, total: 0 };
      const assertWanted = () => {
        assertActive();
        if (entry.cancelled) throw new Error('Clip download cancelled');
      };
      const verify = async () => {
        assertWanted();
        if (isCurrentVersion && !(await isCurrentVersion())) throw new ClipChangedError();
        assertWanted();
      };
      const waitForRetry = (delay) => new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          entry.waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        entry.waiters.add(finish);
        if (entry.cancelled) finish();
      });
      // Register the setup phase before any await: release must also reach a
      // pending cache lookup, not only an already running transfer.
      activeDownloads.set(key, entry);
      entry.promise = (async () => {
        const stored = await cacheRead(key).catch(() => null);
        await verify(); // cached bytes still need a current version and owner
        if (stored instanceof Blob) return stored;
        const blob = await downloadClip(dongleId, filename, (loaded, total) => {
          entry.loaded = loaded;
          entry.total = total;
          for (const listener of entry.listeners) listener(loaded, total);
        }, () => entry.cancelled, waitForRetry);
        await verify();
        if (activeDownloads.get(key) === entry) await cacheWrite(() => storage.setItem(key, blob)).catch(() => {});
        assertWanted();
        return blob;
      })().finally(() => {
        if (activeDownloads.get(key) === entry) activeDownloads.delete(key);
      });
    }

    const consumer = onProgress || Symbol('clip consumer');
    entry.consumers.add(consumer);
    if (onProgress) {
      entry.listeners.add(onProgress);
      if (entry.total) onProgress(entry.loaded, entry.total);
    }
    return entry.promise.finally(() => {
      entry.listeners.delete(onProgress);
      entry.consumers.delete(consumer);
    });
  }

  // A consumer (identified by the progress callback it passed) no longer wants
  // a download; the download is cancelled when its last consumer lets go.
  function releaseClip(dongleId, filename, requestedAt, consumer) {
    const key = cacheKey(dongleId, filename, requestedAt);
    const entry = activeDownloads.get(key);
    if (!entry) return;
    entry.listeners.delete(consumer);
    entry.consumers.delete(consumer);
    if (entry.consumers.size === 0) {
      entry.cancelled = true;
      entry.waiters.forEach((finish) => finish());
      activeDownloads.delete(key);
    }
  }

  async function hasClipBlob(dongleId, filename, requestedAt) {
    const stored = await cacheRead(cacheKey(dongleId, filename, requestedAt)).catch(() => null);
    assertActive();
    return stored instanceof Blob;
  }

  async function call(dongleId, method, params) {
    assertActive();
    const payload = await Athena.postJsonRpcPayload(dongleId, { jsonrpc: '2.0', id: crypto.randomUUID(), method, params });
    assertActive();
    if (!payload) throw new Error('Athena request failed');
    if (payload.error) throw new Error(payload.error.message || 'Athena request failed');
    return payload.result;
  }

  function deviceSupportsClips(device) {
    assertActive();
    if (!deviceVersionAtLeast(device, '0.11.2')) return Promise.resolve(false);
    if (!supportRequests.has(device.dongle_id)) {
      const request = cacheRead(supportCacheKey(device.dongle_id)).catch(() => null).then(async (cachedCommitTimestamp) => {
        if (Number(cachedCommitTimestamp) > 0) return true;
        const version = await call(device.dongle_id, 'getVersion');
        const commitTimestamp = Number(version.commit_date);
        const supported = Number.isFinite(commitTimestamp) && commitTimestamp > 0;
        if (supported) await cacheWrite(() => storage.setItem(supportCacheKey(device.dongle_id), commitTimestamp));
        return supported;
      }).then((supported) => {
        if (!supported) supportRequests.delete(device.dongle_id);
        return supported;
      });
      supportRequests.set(device.dongle_id, request);
      request.catch(() => { if (supportRequests.get(device.dongle_id) === request) supportRequests.delete(device.dongle_id); });
    }
    return supportRequests.get(device.dongle_id);
  }

  async function getClipChunk(dongleId, filename, offset, attempt = 0, isCancelled = () => false, waitForRetry) {
    if (isCancelled()) throw new Error('Clip download cancelled');
    try {
      return await call(dongleId, 'getClipChunk', { filename, offset });
    } catch (error) {
      if (isCancelled()) throw new Error('Clip download cancelled');
      if (error.message !== 'Athena request failed' || attempt === CLIP_RETRY_DELAYS.length) throw error;
      await waitForRetry(CLIP_RETRY_DELAYS[attempt]);
      return getClipChunk(dongleId, filename, offset, attempt + 1, isCancelled, waitForRetry);
    }
  }

  return {
    async getClipState(dongleId, params) {
      return call(dongleId, 'getClipState', params);
    },

    createClip(dongleId, params) {
      return call(dongleId, 'createClip', params);
    },

    async deleteClip(dongleId, params) {
      await invalidateClip(dongleId, params.filename);
      return call(dongleId, 'deleteClip', params);
    },

    async getClipUrl(dongleId, filename, requestedAt, onProgress, isCurrentVersion) {
      const blob = await getClipBlob(dongleId, filename, requestedAt, onProgress, isCurrentVersion);
      assertActive();
      const url = URL.createObjectURL(blob);
      objectUrls.add(url);
      return url;
    },

    hasClipBlob,
    releaseClip,
    deviceSupportsClips,
    isActive: () => !disposed && isCurrent(),
    revokeClipUrl(url) {
      objectUrls.delete(url);
      URL.revokeObjectURL?.(url);
    },
    clear() {
      disposed = true;
      marker.mark(); // survives reload even if the following deletion fails
      for (const entry of activeDownloads.values()) {
        entry.cancelled = true;
        entry.waiters.forEach(finish => finish());
        entry.listeners.clear();
      }
      activeDownloads.clear();
      supportRequests.clear();
      objectUrls.forEach(url => URL.revokeObjectURL?.(url));
      objectUrls.clear();
      return storageBarrier.then(() => Promise.allSettled(writes)).then(() => storage.clear()).then(() => marker.complete(), () => false);
    },
  };
}

// Standalone callers/tests have their own service; the SPA injects one per store.
export const clipDevice = createClipService();
export const deviceSupportsClips = device => clipDevice.deviceSupportsClips(device);
