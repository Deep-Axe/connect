import { beforeEach, describe, expect, it, vi } from 'vitest';

const athena = vi.hoisted(() => ({ postJsonRpcPayload: vi.fn() }));
const stored = vi.hoisted(() => new Map());

vi.mock('../api', () => ({ athena }));
vi.mock('localforage', () => ({
  default: {
    createInstance: () => ({
      getItem: async (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: async (key, value) => { stored.set(key, value); return value; },
      removeItem: async (key) => { stored.delete(key); },
      keys: async () => [...stored.keys()],
    }),
  },
}));

const { ClipChangedError, clipDevice } = await import('./clips');

const D = 'aaaaaaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  stored.clear();
  athena.postJsonRpcPayload.mockImplementation(async (_dongleId, { method }) => (
    method === 'getClipChunk' ? { result: { size: 3, offset: 0, data: btoa('abc') } } : { result: {} }
  ));
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:clip');
});

describe('clip bytes are tied to the version the link names', () => {
  it('caches bytes under a version that still holds after the download', async () => {
    const isCurrentVersion = vi.fn(async () => true);
    await expect(clipDevice.getClipUrl(D, 'a.mp4', 222, null, isCurrentVersion)).resolves.toBe('blob:clip');
    expect(isCurrentVersion).toHaveBeenCalledTimes(2); // before and after
    expect(await clipDevice.hasClipBlob(D, 'a.mp4', 222)).toBe(true);
  });

  it('discards bytes when the clip was replaced during the download', async () => {
    const isCurrentVersion = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(clipDevice.getClipUrl(D, 'a.mp4', 222, null, isCurrentVersion)).rejects.toBeInstanceOf(ClipChangedError);
    expect(await clipDevice.hasClipBlob(D, 'a.mp4', 222)).toBe(false);
  });

  it('downloads nothing when the version is already gone', async () => {
    const isCurrentVersion = vi.fn(async () => false);
    await expect(clipDevice.getClipUrl(D, 'a.mp4', 222, null, isCurrentVersion)).rejects.toBeInstanceOf(ClipChangedError);
    expect(athena.postJsonRpcPayload).not.toHaveBeenCalledWith(D, expect.objectContaining({ method: 'getClipChunk' }));
  });
});

describe('clip downloads belong to the dialogs that asked for them', () => {
  it('releasing the last consumer cancels the download and caches nothing', async () => {
    let answer;
    athena.postJsonRpcPayload.mockImplementation(async (_dongleId, { method }) => (
      method === 'getClipChunk' ? new Promise((resolve) => { answer = resolve; }) : { result: {} }
    ));
    const consumer = vi.fn();
    const url = clipDevice.getClipUrl(D, 'a.mp4', 333, consumer, async () => true);
    await vi.waitFor(() => expect(answer).toBeDefined());
    clipDevice.releaseClip(D, 'a.mp4', 333, consumer); // the dialog closed
    answer({ result: { size: 3, offset: 0, data: btoa('abc') } });
    await expect(url).rejects.toThrow('cancelled');
    expect(await clipDevice.hasClipBlob(D, 'a.mp4', 333)).toBe(false);
  });
});
