import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'history';
import { LOCATION_CHANGE } from 'connected-react-router';
import { createAppStore } from '../store';
import { createInitialState } from '../initialState';
import { checkRouteDetail, checkRoutesData, updateDevices } from './index';
import { endSession } from './session';
import { selectCurrentRoute, selectDevice, selectRoutes } from '../selectors';
import { offsetAt } from '../timeline/offset';
import { seek } from '../timeline/playback';

const mocks = vi.hoisted(() => ({ routes: vi.fn() }));
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';
const NEXT = '2026-08-06--13-00-00';

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
  localStorage.clear();
});

describe('retained route query contract', () => {
  it('reuses A on A → B → A with stable references and inactive entities', async () => {
    const { history, store } = await start(`/${A}`);
    const list = selectRoutes(store.getState());
    history.push(`/${B}`);
    await settle();
    history.push(`/${A}`);
    await settle();
    expect(mocks.routes).toHaveBeenCalledTimes(2);
    expect(selectRoutes(store.getState())).toBe(list);
    expect(Object.keys(store.getState().entities.routes)).toHaveLength(2);
  });

  it('refreshes stale lists while retaining visible data during loading', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1900000000000);
    const { store } = await start(`/${A}`);
    const previous = selectRoutes(store.getState());
    await store.dispatch(checkRoutesData());
    expect(mocks.routes).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1900000300000);
    let answer;
    mocks.routes.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pending = store.dispatch(checkRoutesData());
    await settle();
    expect(selectRoutes(store.getState())).toBe(previous);
    answer([route(A, NEXT)]);
    await pending;
    expect(selectRoutes(store.getState())[0].log_id).toBe(NEXT);
  });

  it('keeps dashboard lists distinct from detail queries', async () => {
    const { history, store } = await start(`/${A}/${LOG}`);
    expect(selectRoutes(store.getState())).toBeNull();
    history.push(`/${A}`);
    await settle();
    expect(mocks.routes).toHaveBeenCalledTimes(2);
    expect(mocks.routes.mock.calls[0][4]).toBe(`${A}|${LOG}`);
    expect(mocks.routes.mock.calls[1][4]).toBeUndefined();
  });

  it('newest forced query wins when the old response arrives last', async () => {
    const answers = [];
    mocks.routes.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const { store } = await start(`/${A}`);
    const refresh = store.dispatch(checkRoutesData({ force: true }));
    await settle();
    answers[1]([route(A, NEXT)]);
    await refresh;
    answers[0]([route(A, LOG)]);
    await settle();
    expect(selectRoutes(store.getState())[0].log_id).toBe(NEXT);
  });

  it('failed queries retry and empty successful results are reusable', async () => {
    mocks.routes.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    const { store } = await start(`/${A}`);
    await store.dispatch(checkRoutesData());
    expect(selectRoutes(store.getState())).toEqual([]);
    expect(mocks.routes).toHaveBeenCalledTimes(2);
    await store.dispatch(checkRoutesData());
    expect(mocks.routes).toHaveBeenCalledTimes(2);
  });

  it('rejects private route results from an ended session', async () => {
    let answer;
    mocks.routes.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { store } = await start(`/${A}`);
    store.dispatch(endSession());
    answer([route(A)]);
    await settle();
    expect(store.getState().entities.routes).toEqual({});
  });

  it('invalidates maxqlog assets and reclamps changed-duration playback', async () => {
    const { store } = await start(`/${A}/${LOG}`);
    store.dispatch({ type: 'ACTION_UPDATE_ROUTE_EVENTS', fullname: `${A}|${LOG}`, maxqlog: 0, events: [] });
    store.dispatch(seek(55000));
    mocks.routes.mockResolvedValue([
      route(A, LOG, { maxqlog: 1, segment_end_times: [41000], end_time_utc_millis: 41000 }),
    ]);
    await store.dispatch(checkRouteDetail({ force: true }));
    expect(selectCurrentRoute(store.getState()).events).toBeUndefined();
    expect(store.getState().zoom.end).toBe(40000);
    expect(store.getState().offset).toBe(40000);
  });

  it('remembers drive playback separately from active selection', async () => {
    const { history, store } = await start(`/${A}/${LOG}`);
    store.dispatch(seek(15000));
    const current = selectCurrentRoute(store.getState());
    history.push(`/${B}/${LOG}`);
    await settle();
    history.push(`/${A}/${LOG}`);
    await settle();
    expect(selectCurrentRoute(store.getState())).toBe(current);
    expect(store.getState().offset).toBe(15000);
    expect(mocks.routes).toHaveBeenCalledTimes(2);
  });

  it('refreshing devices keeps fetched Athena fields and revokes removed ownership', async () => {
    const { store } = await start(`/${A}`);
    store.dispatch({ type: 'ACTION_UPDATE_DEVICE_NETWORK', dongleId: A, networkMetered: true });
    store.dispatch(updateDevices([{ dongle_id: A, alias: 'renamed', is_owner: true }]));
    expect(selectDevice(store.getState()).network_metered).toBe(true);
    store.dispatch(updateDevices([]));
    expect(selectDevice(store.getState()).is_owner).toBe(false);
  });

  it('zero-start loops wrap playback and zero-duration loops avoid NaN', () => {
    const state = {
      offset: 9000,
      startTime: 0,
      desiredPlaySpeed: 1,
      isBufferingVideo: false,
      loop: { startTime: 0, duration: 10000 },
    };
    expect(offsetAt(state, 2000)).toBe(1000);
    expect(Number.isFinite(offsetAt({ ...state, loop: { startTime: 0, duration: 0 } }, 2000))).toBe(true);
  });

  it('normalization preserves immutable backend payloads', async () => {
    const payload = Object.freeze(route(A, LOG, { length: 5 }));
    mocks.routes.mockResolvedValue([payload]);
    const { store } = await start(`/${A}`);
    expect(selectRoutes(store.getState())[0].distance).toBe(5);
    expect(payload.distance).toBeUndefined();
  });
});
