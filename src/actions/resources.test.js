import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import reducer from '../reducers/globalState';
import { createInitialState } from '../initialState';
import { createRoutingServices } from '../routing/services';
import { fetchEvents } from './cached';
import { fetchUploadQueue, doUpload } from './files';
import { endSession } from './session';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../api', () => ({
  request: { configure: vi.fn() },
  athena: { configure: vi.fn(), postJsonRpcPayload: mocks.rpc },
  billing: { configure: vi.fn() },
}));

vi.mock('../api/backend', () => ({
  api: {
    routeAssets: { events: (_r, j) => `https://test/events/${j}`, coords: (_r, j) => `https://test/coords/${j}` },
  },
}));

const A = 'aaaaaaaaaaaaaaaa';
const LOG = '2026-08-06--12-00-00';
const route = { fullname: `${A}|${LOG}`, log_id: LOG, duration: 10000, maxqlog: 0 };

function harness() {
  let state = {
    ...createInitialState(),
    dongleId: A,
    device: { dongle_id: A, openpilot_version: '0.9.9' },
    devices: [],
    routes: [route],
  };
  const services = createRoutingServices();
  const dispatch = (action) => {
    if (typeof action === 'function') return action(dispatch, () => state, services);
    state = reducer(state, action);
    return action;
  };
  return {
    dispatch,
    getState: () => state,
    set: (s) => {
      state = s;
    },
    services,
  };
}

const tick = async () => {
  for (let i = 0; i < 12; i++) {
    // Flush dependent promise phases without advancing timers.
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

beforeEach(() => {
  mocks.rpc.mockReset();
  window.indexedDB = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('old maxqlog assets cannot overwrite newer maxqlog assets', async () => {
  const h = harness();
  const replies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise((resolve) => replies.push(resolve))),
  );
  const old = h.dispatch(fetchEvents(route));
  await tick();
  const newer = { ...route, maxqlog: 1 };
  h.set({ ...h.getState(), routes: [newer] });
  const fresh = h.dispatch(fetchEvents(newer));
  await tick();
  const event = (n) => [{ type: 'user_bookmark', route_offset_millis: n, data: {} }];
  replies[1]({ ok: true, json: async () => event(20) });
  replies[2]({ ok: true, json: async () => [] });
  await fresh;
  replies[0]({ ok: true, json: async () => event(10) });
  await old;
  expect(h.getState().routes[0].events[0].route_offset_millis).toBe(20);
});

it('HTTP asset failure remains retryable rather than committing empty loaded data', async () => {
  const h = harness();
  const fetch = vi.fn(async () => ({ ok: false, status: 503 }));
  vi.stubGlobal('fetch', fetch);
  await h.dispatch(fetchEvents(route));
  await h.dispatch(fetchEvents(route));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('thrown asset failures settle and leave map retryable', async () => {
  const h = harness();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValueOnce({ ok: true, json: async () => [] });
  vi.stubGlobal('fetch', fetch);
  await h.dispatch(fetchEvents(route));
  await h.dispatch(fetchEvents(route));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(h.services.requests.events.size).toBe(0);
});

it('completed empty upload queues can be requested again', async () => {
  const h = harness();
  mocks.rpc.mockResolvedValue({ result: [] });
  await h.dispatch(fetchUploadQueue(A));
  await h.dispatch(fetchUploadQueue(A));
  const lists = mocks.rpc.mock.calls.filter(([, p]) => p.method === 'listUploadQueue');
  expect(lists).toHaveLength(2);
});

it('late old-session queue result cannot restart old polling after endSession', async () => {
  vi.useFakeTimers();
  const h = harness();
  let resolveList;
  mocks.rpc.mockImplementation((_d, p) =>
    p.method === 'listUploadQueue'
      ? new Promise((resolve) => {
          resolveList = resolve;
        })
      : Promise.resolve({ result: 1 }),
  );
  const pending = h.dispatch(fetchUploadQueue(A));
  await tick();
  h.dispatch(endSession());
  resolveList({
    result: [{ id: 'upload1', url: `https://test/${A}/${LOG}/0/qcamera.ts`, progress: 0, current: true }],
  });
  await pending;
  await vi.advanceTimersByTimeAsync(2000);
  await tick();
  const lists = mocks.rpc.mock.calls.filter(([, p]) => p.method === 'listUploadQueue');
  expect(lists).toHaveLength(1);
});

it('a hung old queue cannot block the new session and its finally cannot clear the new owner', async () => {
  const h = harness();
  let oldDone, newDone;
  mocks.rpc.mockImplementation((_d, p) =>
    p.method === 'listUploadQueue'
      ? new Promise((resolve) => {
          if (!oldDone) oldDone = resolve;
          else newDone = resolve;
        })
      : Promise.resolve({ result: 1 }),
  );
  const old = h.dispatch(fetchUploadQueue(A));
  await tick();
  h.dispatch(endSession());
  const fresh = h.dispatch(fetchUploadQueue(A));
  await tick();
  expect(newDone).toBeTypeOf('function');
  oldDone({ result: [] });
  await old;
  expect(h.services.uploads.inFlight).toBe(true);
  newDone({ result: [] });
  await fresh;
  expect(h.services.uploads.inFlight).toBe(false);
});

it('an unsupported batch reply after logout cannot start its upload fallback', async () => {
  const h = harness();
  let reply;
  h.set({ ...h.getState(), device: { dongle_id: A, openpilot_version: '0.9.9' } });
  mocks.rpc.mockImplementation((_d, p) =>
    p.method === 'uploadFilesToUrls' ? new Promise((r) => (reply = r)) : Promise.resolve({ result: [] }),
  );
  const pending = h.dispatch(doUpload(A, [LOG + '--0/qcamera.ts'], ['https://signed']));
  await tick();
  h.dispatch(endSession());
  reply({ error: { code: -32000, data: { message: 'too many values to unpack (expected 3)' } } });
  await pending;
  expect(mocks.rpc.mock.calls.some(([, p]) => p.method === 'uploadFileToUrl')).toBe(false);
});

it('a queued RPC retry cannot start after its session ends', async () => {
  vi.useFakeTimers();
  const h = harness();
  mocks.rpc.mockRejectedValueOnce(new Error('temporary'));
  const pending = h.dispatch(doUpload(A, [LOG + '--0/qcamera.ts'], ['https://signed']));
  await tick();
  h.dispatch(endSession());
  await vi.advanceTimersByTimeAsync(2000);
  await pending;
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
