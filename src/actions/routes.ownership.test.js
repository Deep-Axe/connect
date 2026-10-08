import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'history';
import { LOCATION_CHANGE } from 'connected-react-router';
import { createAppStore } from '../store';
import { createInitialState } from '../initialState';
import { checkRouteDetail, checkRoutesData, updateDevices } from './index';
import { endSession } from './session';
import { selectCurrentRoute, selectDevice, selectRoutes, selectSelectedRouteMissing } from '../selectors';
import { seek } from '../timeline/playback';

const mocks = vi.hoisted(() => ({ routes: vi.fn() }));
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';

vi.mock('../api/backend', () => ({
  activeBackendType: () => null,
  api: {
    auth: { isAuthenticated: () => true },
    account: { getProfile: async () => ({ id: 'user' }) },
    devices: { listDevices: async () => [{ dongle_id: A }, { dongle_id: B }], fetchDevice: async () => ({}) },
    routes: { getRoutesSegments: mocks.routes },
  },
}));

vi.mock('../api', () => ({
  request: { configure: vi.fn() },
  billing: { configure: vi.fn() },
  athena: { configure: vi.fn() },
}));

vi.mock('../utils/webrtc', () => ({
  webrtcConnectionManager: { streamDongleId: null, deviceChanged: vi.fn(), disconnect: vi.fn() },
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function route(id, log = LOG, extra = {}) {
  return {
    fullname: `${id}|${log}`,
    url: 'https://test',
    create_time: 1,
    segment_start_times: [1000],
    segment_end_times: [61000],
    segment_numbers: [0],
    start_time_utc_millis: 1000,
    end_time_utc_millis: 61000,
    maxqlog: 0,
    ...extra,
  };
}

async function start(url) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const store = createAppStore(history, createInitialState());
  const changed = (location, action) => store.dispatch({ type: LOCATION_CHANGE, payload: { location, action } });
  changed(history.location, history.action);
  history.listen(changed);
  await settle();
  await settle();
  return { history, store };
}

beforeEach(() => {
  mocks.routes
    .mockReset()
    .mockImplementation(async (id, _s, _e, _l, fullname) => [route(id, fullname?.split('|')[1] ?? LOG)]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('an older missing detail cannot delete a newer list entity', async () => {
  const answers = [];
  mocks.routes.mockImplementation(() => new Promise((r) => answers.push(r)));
  const { history, store } = await start(`/${A}/${LOG}`);
  history.push(`/${A}`);
  await settle();
  answers[1]([route(A)]);
  await settle();
  expect(store.getState().entities.routes[`${A}|${LOG}`]).toBeTruthy();
  answers[0]([]);
  await settle();
  expect(store.getState().entities.routes[`${A}|${LOG}`]).toBeTruthy();
});

it('newly loaded list metadata repairs a missing detail status', async () => {
  mocks.routes.mockResolvedValueOnce([]);
  const { history, store } = await start(`/${A}/${LOG}`);
  expect(selectSelectedRouteMissing(store.getState())).toBe(true);
  history.push(`/${A}`);
  await settle();
  history.push(`/${A}/${LOG}`);
  await settle();
  expect(selectCurrentRoute(store.getState())).toBeTruthy();
  expect(selectSelectedRouteMissing(store.getState())).toBe(false);
});

it('a regranted account device does not retain its old shared marker', async () => {
  const { store } = await start(`/${A}`);
  store.dispatch(updateDevices([]));
  store.dispatch(updateDevices([{ dongle_id: A, is_owner: true, alias: 'returned' }]));
  expect(selectDevice(store.getState()).is_owner).toBe(true);
  expect(selectDevice(store.getState()).shared).not.toBe(true);
});

it('a route request queued before logout does not start after logout', async () => {
  const { store } = await start(`/${A}`);
  mocks.routes.mockClear();
  const pending = store.dispatch(checkRoutesData({ force: true }));
  store.dispatch(endSession());
  await pending;
  expect(mocks.routes).not.toHaveBeenCalled();
});

it('a new whole drive starts at its own position while metadata is pending', async () => {
  const { history, store } = await start(`/${A}/${LOG}`);
  store.dispatch(seek(15000));
  let answer;
  mocks.routes.mockImplementation(() => new Promise((r) => (answer = r)));
  history.push(`/${B}/${LOG}`);
  await settle();
  answer([route(B)]);
  await settle();
  expect(store.getState().offset).toBe(0);
});

it('positive control: unchanged inactive list entity references survive another route refresh', async () => {
  const { history, store } = await start(`/${A}`);
  const list = selectRoutes(store.getState());
  history.push(`/${B}`);
  await settle();
  await store.dispatch(checkRoutesData({ force: true }));
  history.push(`/${A}`);
  await settle();
  expect(selectRoutes(store.getState())).toBe(list);
});

it('null transport failures do not become fresh empty route lists', async () => {
  const actual = await vi.importActual('../api');
  actual.request.configure('token', () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  );
  mocks.routes.mockImplementation(() => actual.request.get('review/routes'));
  const { store } = await start(`/${A}`);
  expect(selectRoutes(store.getState())).toBeNull();
  await store.dispatch(checkRoutesData());
  expect(mocks.routes).toHaveBeenCalledTimes(2);
});

it('null transport failures do not become fresh missing drive results', async () => {
  mocks.routes.mockResolvedValueOnce(null);
  const { store } = await start(`/${A}/${LOG}`);
  expect(selectSelectedRouteMissing(store.getState())).toBe(false);
  await store.dispatch(checkRouteDetail());
  expect(mocks.routes).toHaveBeenCalledTimes(2);
});
