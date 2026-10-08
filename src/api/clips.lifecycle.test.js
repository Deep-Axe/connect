import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ athena: { postJsonRpcPayload: rpc } }));
import { createClipService } from './clips';

const D = 'aaaaaaaaaaaaaaaa';
const chunk = { result: { size: 3, offset: 0, data: btoa('abc') } };
function storage() {
  const records = new Map();
  return {
    records,
    getItem: vi.fn(async key => records.get(key)),
    setItem: vi.fn(async (key, value) => { records.set(key, value); }),
    keys: async () => [...records.keys()],
    removeItem: async key => { records.delete(key); },
    clear: vi.fn(async () => records.clear()),
  };
}
beforeEach(() => { localStorage.clear(); rpc.mockReset(); URL.createObjectURL = vi.fn(() => 'blob:clip'); URL.revokeObjectURL = vi.fn(); });
afterEach(() => vi.useRealTimers());

it('stores own independent transfer maps and releasing one consumer does not cancel another store', async () => {
  const answers = []; rpc.mockImplementation(() => new Promise(resolve => answers.push(resolve)));
  const a = createClipService({ storage: storage() }); const b = createClipService({ storage: storage() });
  const consumerA = vi.fn(); const consumerB = vi.fn();
  const old = a.getClipUrl(D, 'a.mp4', 1, consumerA, async () => true);
  const oldResult = old.catch(error => error);
  const fresh = b.getClipUrl(D, 'a.mp4', 1, consumerB, async () => true);
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  a.releaseClip(D, 'a.mp4', 1, consumerA);
  answers.forEach(resolve => resolve(chunk));
  expect((await oldResult).message).toContain('cancelled');
  await expect(fresh).resolves.toBe('blob:clip');
  expect(await a.hasClipBlob(D, 'a.mp4', 1)).toBe(false);
  expect(await b.hasClipBlob(D, 'a.mp4', 1)).toBe(true);
});

it('logout reaches the pending cache lookup and creates no object URL or network task', async () => {
  const cache = storage(); let answer;
  cache.getItem.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const service = createClipService({ storage: cache });
  const pending = service.getClipUrl(D, 'a.mp4', 1, vi.fn(), async () => true);
  const rejected = pending.catch(error => error);
  await vi.waitFor(() => expect(answer).toBeDefined());
  await service.clear(); answer(new Blob(['secret'])); expect(await rejected).toBeInstanceOf(Error);
  expect(rpc).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(cache.clear).toHaveBeenCalledTimes(1);
});

it('the next session waits for old writes and the following byte-cache clear', async () => {
  const cache = storage(); let finishWrite;
  cache.setItem.mockImplementation((key, value) => new Promise(resolve => {
    finishWrite = () => { cache.records.set(key, value); resolve(); };
  }));
  rpc.mockResolvedValue(chunk);
  const oldService = createClipService({ storage: cache });
  const pending = oldService.getClipUrl(D, 'a.mp4', 1, vi.fn(), async () => true);
  const rejected = pending.catch(error => error);
  await vi.waitFor(() => expect(finishWrite).toBeDefined());
  const clearing = oldService.clear();
  const newService = createClipService({ storage: cache, ready: clearing });
  const read = newService.hasClipBlob(D, 'a.mp4', 1);
  const readsBefore = cache.getItem.mock.calls.length;
  await Promise.resolve(); expect(cache.getItem).toHaveBeenCalledTimes(readsBefore);
  finishWrite(); expect(await rejected).toBeInstanceOf(Error); await clearing;
  expect(await read).toBe(false); expect(cache.records.size).toBe(0);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('old support responses cannot persist after logout and a replacement service retries', async () => {
  let answer; rpc.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const cache = storage(); const old = createClipService({ storage: cache });
  const device = { dongle_id: D, openpilot_version: '0.11.2' };
  const pending = old.deviceSupportsClips(device); const rejected = pending.catch(error => error);
  await vi.waitFor(() => expect(answer).toBeDefined());
  await old.clear(); answer({ result: { commit_date: 123 } }); expect(await rejected).toBeInstanceOf(Error);
  expect(cache.setItem).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ result: { commit_date: 456 } });
  expect(await createClipService({ storage: cache }).deviceSupportsClips(device)).toBe(true);
});

it('disposing a service wakes retry waits and releases its object URLs', async () => {
  vi.useFakeTimers(); rpc.mockResolvedValue(null);
  const service = createClipService({ storage: storage() });
  const pending = service.getClipUrl(D, 'a.mp4', 1, vi.fn(), async () => true);
  const rejected = pending.catch(error => error);
  await vi.advanceTimersByTimeAsync(0); expect(rpc).toHaveBeenCalledTimes(1);
  await service.clear(); expect(await rejected).toBeInstanceOf(Error); await vi.advanceTimersByTimeAsync(20_000);
  expect(rpc).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  const successful = createClipService({ storage: storage() }); rpc.mockResolvedValue(chunk);
  await successful.getClipUrl(D, 'b.mp4', 2, null, async () => true);
  await successful.clear(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clip');
});

it('a failed physical clear quarantines old bytes until a replacement retries the purge', async () => {
  const cache = storage(); cache.records.set(`clip:${D}/a.mp4/1`, new Blob(['old private bytes']));
  cache.clear.mockRejectedValueOnce(new Error('storage unavailable')).mockRejectedValueOnce(new Error('still unavailable'));
  const old = createClipService({ storage: cache });
  const clearing = old.clear();
  const replacement = createClipService({ storage: cache, ready: clearing });
  expect(await replacement.hasClipBlob(D, 'a.mp4', 1)).toBe(false);
  expect(cache.getItem).not.toHaveBeenCalled();
  expect(cache.records.size).toBe(1); // quarantine, rather than a false assertion that deletion worked
  expect(await replacement.hasClipBlob(D, 'a.mp4', 1)).toBe(false);
  expect(cache.records.size).toBe(0);
  expect(cache.clear).toHaveBeenCalledTimes(3);
});

it('a fresh service after reload honors the failed previous logout without an in-memory ready promise', async () => {
  const cache = storage(); cache.records.set(`clip:${D}/public-route.mp4/1`, new Blob(['old private bytes']));
  cache.clear.mockRejectedValueOnce(new Error('temporarily blocked'));
  await createClipService({ storage: cache }).clear();
  expect(localStorage.getItem('connect:cache-purge:clips')).toBe('1');
  const reloaded = createClipService({ storage: cache });
  expect(await reloaded.hasClipBlob(D, 'public-route.mp4', 1)).toBe(false);
  expect(cache.clear).toHaveBeenCalledTimes(2);
  expect(cache.records.size).toBe(0);
  expect(localStorage.getItem('connect:cache-purge:clips')).toBeNull();
});
