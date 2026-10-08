import { describe, expect, it, vi } from 'vitest';

const athena = vi.hoisted(() => ({ postJsonRpcPayload: vi.fn() }));
vi.mock('../api', () => ({ athena, billing: {} }));

const { fetchUploadQueue } = await import('./files');
const { createRoutingServices } = await import('../routing/services');

const A = 'aaaaaaaaaaaaaaaa';

function run(thunk, state, services) {
  const dispatched = [];
  const dispatch = (action) => (typeof action === 'function'
    ? action(dispatch, () => state, services)
    : dispatched.push(action));
  return { promise: thunk(dispatch, () => state, services), dispatched };
}

describe('upload queue poll', () => {
  it('a reply that is not a queue stops the poll instead of throwing', async () => {
    athena.postJsonRpcPayload.mockResolvedValue({ result: {} });
    const services = createRoutingServices();
    const state = { dongleId: A, sessionEpoch: 0, device: { dongle_id: A }, devices: [], filesUploading: {} };
    const { promise, dispatched } = run(fetchUploadQueue(A), state, services);
    await expect(promise).resolves.toBeUndefined();
    expect(services.uploads.timer).toBeNull();
    expect(dispatched.some((a) => a.type === 'ACTION_FILES_UPLOADING')).toBe(false);
  });

  it('each store has its own poll', async () => {
    athena.postJsonRpcPayload.mockReturnValue(new Promise(() => {})); // never answers
    const one = createRoutingServices();
    const two = createRoutingServices();
    const state = { dongleId: A, sessionEpoch: 0, device: { dongle_id: A }, devices: [], filesUploading: {} };
    run(fetchUploadQueue(A), state, one);
    expect(one.uploads.timer).toBe(true);
    expect(two.uploads.timer).toBeNull();
  });
});
