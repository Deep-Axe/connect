import { describe, expect, it, vi } from 'vitest';

const athena = vi.hoisted(() => ({ postJsonRpcPayload: vi.fn() }));
vi.mock('../api', () => ({ athena, billing: {} }));

const { cancelUploads, fetchUploadQueue, pollUploadQueue, stopPollingUploadQueue, uploadQueuePollers } = await import('./files');
const { createRoutingServices } = await import('../routing/services');
const { default: reducer } = await import('../reducers/globalState');
const { createInitialState } = await import('../initialState');

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';

// a store-like harness with the real reducer
function harness(overrides = {}) {
  let state = { ...createInitialState(), dongleId: A, device: { dongle_id: A }, devices: [{ dongle_id: A }, { dongle_id: B }], ...overrides };
  const services = createRoutingServices();
  const dispatch = (action) => (typeof action === 'function'
    ? action(dispatch, () => state, services)
    : (state = reducer(state, action), action));
  return { dispatch, getState: () => state, services };
}

const queueItem = (dongleId, id) => ({ id, url: `https://x/${dongleId}/${LOG}/0/qcamera.ts?sig`, progress: 0.5, current: true });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('upload queue poll', () => {
  it('a reply that is not a queue stops the poll instead of throwing', async () => {
    athena.postJsonRpcPayload.mockResolvedValue({ result: {} });
    const h = harness();
    await expect(h.dispatch(fetchUploadQueue(A))).resolves.toBeUndefined();
    const target = h.services.uploads.targets.get(A);
    expect(target.timer).toBeNull();
    expect(target.inFlight).toBe(false);
  });

  it('each store has its own poll', () => {
    athena.postJsonRpcPayload.mockReturnValue(new Promise(() => {})); // never answers
    const one = harness();
    const two = harness();
    one.dispatch(fetchUploadQueue(A));
    expect(one.services.uploads.targets.get(A).inFlight).toBe(true);
    expect(two.services.uploads.targets.get(A)).toBeUndefined();
  });

  it("another device's queue loads over the selected one without touching it", async () => {
    athena.postJsonRpcPayload.mockImplementation(async (dongleId, { method }) => (
      method === 'listUploadQueue' ? { result: [queueItem(dongleId, `${dongleId}-1`)] } : { result: {} }
    ));
    const h = harness();
    const menu = {};
    const dialog = {};
    h.dispatch(pollUploadQueue(menu, A)); // A's drive menu
    h.dispatch(pollUploadQueue(dialog, B)); // B's upload panel over A's drive
    await settle(); await settle();
    const state = h.getState();
    expect(Object.keys(state.uploadQueues[B].uploading)).toEqual([`${B}-1`]);
    expect(Object.keys(state.uploadQueues[A].uploading)).toEqual([`${A}-1`]);
    expect(Object.keys(state.filesUploading)).toEqual([`${A}-1`]); // the selected device's view
    expect(h.dispatch(uploadQueuePollers(B))).toBe(1);

    // B's cancellation edits B's queue only
    athena.postJsonRpcPayload.mockResolvedValue({ result: { success: true } });
    await h.dispatch(cancelUploads(B, [`${B}-1`]));
    expect(h.getState().uploadQueues[B].uploading).toEqual({});
    expect(Object.keys(h.getState().filesUploading)).toEqual([`${A}-1`]);

    // closing B's panel stops B's poll, A's keeps going
    h.dispatch(stopPollingUploadQueue(dialog));
    expect(h.services.uploads.targets.get(B).timer).toBeNull();
    expect(h.services.uploads.targets.get(A).timer).not.toBeNull();
    h.dispatch(stopPollingUploadQueue(menu));
    expect(h.dispatch(uploadQueuePollers())).toBe(0);
  });
});

describe('adversarial upload owner retargeting', () => {
  it('moving one consumer to another device releases its old device poll', async () => {
    athena.postJsonRpcPayload.mockImplementation(async (dongleId, { method }) => (
      method === 'listUploadQueue' ? { result: [queueItem(dongleId, `${dongleId}-1`)] } : { result: {} }
    ));
    const h = harness();
    const owner = {};
    h.dispatch(pollUploadQueue(owner, A));
    await settle(); await settle();
    h.getState().dongleId = B;
    h.dispatch(pollUploadQueue(owner, B));
    await settle(); await settle();
    const observed = {
      oldOwners: h.dispatch(uploadQueuePollers(A)),
      oldTimer: Boolean(h.services.uploads.targets.get(A).timer),
      newOwners: h.dispatch(uploadQueuePollers(B)),
    };
    h.dispatch(stopPollingUploadQueue(owner));
    expect(observed).toEqual({ oldOwners: 0, oldTimer: false, newOwners: 1 });
  });

  it('returning to a target does not wait for its released old request', async () => {
    const replies = [];
    athena.postJsonRpcPayload.mockImplementation((dongleId, { method }) => {
      if (method === 'listUploadQueue' && dongleId === A) return new Promise(resolve => replies.push(resolve));
      return Promise.resolve({ result: method === 'listUploadQueue' ? [] : {} });
    });
    const h = harness();
    const owner = {};
    h.dispatch(pollUploadQueue(owner, A));
    h.getState().dongleId = B;
    h.dispatch(pollUploadQueue(owner, B));
    h.getState().dongleId = A;
    h.dispatch(pollUploadQueue(owner, A));
    expect(replies).toHaveLength(2);
    replies[0]({ result: [queueItem(A, 'old')] });
    await settle();
    expect(h.services.uploads.targets.get(A).inFlight).toBe(true); // old finally cannot release the new request
    expect(h.getState().uploadQueues[A]).toBeUndefined();
    replies[1]({ result: [queueItem(A, 'new')] });
    await settle();
    expect(Object.keys(h.getState().uploadQueues[A].uploading)).toEqual(['new']);
    h.dispatch(stopPollingUploadQueue(owner));
  });
});
