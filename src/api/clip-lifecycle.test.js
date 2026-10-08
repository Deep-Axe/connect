import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ athena: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), stored: new Map() }));
vi.mock('../api', () => ({ athena: { postJsonRpcPayload: mocks.athena } }));
vi.mock('localforage', () => ({ default: { createInstance: () => ({
  getItem: mocks.getItem, setItem: mocks.setItem,
  removeItem: async key => mocks.stored.delete(key), keys: async () => [...mocks.stored.keys()],
}) } }));
const D = 'aaaaaaaaaaaaaaaa';
// Sequential microtasks flush the promise phases without advancing timers.
// eslint-disable-next-line no-await-in-loop
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.stored.clear();
  mocks.getItem.mockImplementation(async key => mocks.stored.get(key) ?? null);
  mocks.setItem.mockImplementation(async (key, value) => { mocks.stored.set(key, value); });
  mocks.athena.mockResolvedValue({ result: { size: 3, offset: 0, data: btoa('abc') } });
  URL.createObjectURL = vi.fn(() => 'blob:review');
});

describe('adversarial clip lifecycle', () => {
  it('release during async cache lookup prevents later download/cache installation', async () => {
    let resolveLookup;
    mocks.getItem.mockImplementationOnce(() => new Promise(r => { resolveLookup = r; }));
    const { clipDevice } = await import('./clips');
    const progress = vi.fn();
    const pending = clipDevice.getClipUrl(D, 'late.mp4', 1, progress, async () => true);
    clipDevice.releaseClip(D, 'late.mp4', 1, progress);
    await flush();
    resolveLookup(null);
    await pending.catch(() => null);
    expect({ chunks: mocks.athena.mock.calls.length, cacheWrites: mocks.setItem.mock.calls.length })
      .toEqual({ chunks: 0, cacheWrites: 0 });
  });

  it('a cached preview verifies requested version before displaying the blob', async () => {
    mocks.stored.set(`clip:${D}/cached.mp4/1`, new Blob(['old']));
    const { clipDevice, ClipChangedError } = await import('./clips');
    const verify = vi.fn(async () => false);
    await expect(clipDevice.getClipUrl(D, 'cached.mp4', 1, vi.fn(), verify)).rejects.toBeInstanceOf(ClipChangedError);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('two consumers share bytes and releasing one preserves the other', async () => {
    let resolveChunk;
    mocks.athena.mockImplementationOnce(() => new Promise(r => { resolveChunk = r; }));
    const { clipDevice } = await import('./clips');
    const first = vi.fn(), second = vi.fn();
    const a = clipDevice.getClipUrl(D, 'shared.mp4', 1, first, async () => true);
    const b = clipDevice.getClipUrl(D, 'shared.mp4', 1, second, async () => true);
    await flush();
    clipDevice.releaseClip(D, 'shared.mp4', 1, first);
    resolveChunk({ result: { size: 3, offset: 0, data: btoa('abc') } });
    await expect(b).resolves.toBe('blob:review');
    await a;
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(3, 3);
    expect(mocks.athena).toHaveBeenCalledTimes(1);
  });

  it('release after download starts discards bytes before persisting', async () => {
    let resolveChunk;
    mocks.athena.mockImplementationOnce(() => new Promise(r => { resolveChunk = r; }));
    const { clipDevice } = await import('./clips');
    const progress = vi.fn();
    const pending = clipDevice.getClipUrl(D, 'cancel.mp4', 1, progress, async () => true);
    const rejection = pending.catch(error => error);
    await flush();
    clipDevice.releaseClip(D, 'cancel.mp4', 1, progress);
    resolveChunk({ result: { size: 3, offset: 0, data: btoa('abc') } });
    expect((await rejection).message).toContain('cancelled');
    expect(mocks.setItem).not.toHaveBeenCalled();
  });

  it('release cancels scheduled chunk retries after a transient failure', async () => {
    vi.useFakeTimers();
    try {
      mocks.athena.mockResolvedValue(null);
      const { clipDevice } = await import('./clips');
      const progress = vi.fn();
      const pending = clipDevice.getClipUrl(D, 'retry.mp4', 1, progress, async () => true).catch(() => null);
      await flush();
      expect(mocks.athena).toHaveBeenCalledTimes(1);
      clipDevice.releaseClip(D, 'retry.mp4', 1, progress);
      await vi.runAllTimersAsync();
      await pending;
      expect(mocks.athena).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
