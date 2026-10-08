import { selectFiles } from '../resources/selectors';
// URL in → state out, through the real store, reducers and middleware. The
// memory history is wired to the store exactly as ConnectedRouter does it:
// the initial location is dispatched once, then every history change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'history';
import { LOCATION_CHANGE } from 'connected-react-router';

// the action ConnectedRouter dispatches for every location
const onLocationChanged = (location, action) => ({ type: LOCATION_CHANGE, payload: { location, action } });

import { createInitialState } from '../initialState';
import { createAppStore } from '../store';
import { selectDevice, selectDevices, selectCurrentRoute, selectRoutes } from '../selectors';
import localforage from 'localforage';
import { hardNavigate } from '../utils/navigation';
import { webrtcConnectionManager } from '../utils/webrtc';
import { bootstrapSession, endSession } from '../actions/session';
import { bufferVideo, seek } from '../timeline/playback';
import { currentOffset } from '../timeline';
import { pollUploadQueue, stopPollingUploadQueue, updateFiles, uploadQueuePollers } from '../actions/files';
import * as Types from '../actions/types';
import {
  selectNavLocation, selectSelectedRouteId, selectSelectedRouteMissing, selectSelectionOutOfRange, selectView,
} from './selectors';
import { checkRoutesData, leaveForExternalUrl, renameDevice, updateDevice, updateDevices } from '../actions';
import { billing } from '../api';
import { MODALS, modalOf } from './codec';
import {
  closeModal, driveBack, leavePage, openModal, openedInteractively, toDashboard, toDriveRange, toPrime,
} from './navigate';

const api = vi.hoisted(() => ({
  authenticated: true,
  backendType: null,
  getRoutesSegments: vi.fn(),
  listDevices: vi.fn(),
  getProfile: vi.fn(),
  fetchDevice: vi.fn(),
  setDeviceAlias: vi.fn(),
}));

vi.mock('../api/backend', () => ({
  activeBackendType: () => api.backendType,
  selectBackendType: (pathname) => (pathname.startsWith('/deadbeefdeadbeef') || pathname.startsWith('/demo') ? 'demo' : 'real'),
  api: {
    auth: { isAuthenticated: () => api.authenticated, logOut: vi.fn() },
    account: { getProfile: api.getProfile },
    devices: { listDevices: api.listDevices, fetchDevice: api.fetchDevice, setDeviceAlias: api.setDeviceAlias },
    routes: { getRoutesSegments: api.getRoutesSegments },
  },
}));
vi.mock('../api', () => ({
  request: {configure:vi.fn()}, athena: {configure:vi.fn()}, billing: {configure:vi.fn(), getSubscribeInfo: vi.fn(async () => null), getSubscription: vi.fn(async () => null) },
}));
vi.mock('../utils/webrtc', () => {
  // tracks which device's stream page holds the connection, like the real one
  const manager = {
    streamDongleId: null,
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    deviceChanged: vi.fn(),
    enterStream: vi.fn((dongleId) => { manager.streamDongleId = dongleId; }),
    leaveStream: vi.fn((dongleId) => { if (manager.streamDongleId === dongleId) manager.streamDongleId = null; }),
  };
  return { webrtcConnectionManager: manager };
});
vi.mock('../utils/navigation', () => ({ hardNavigate: vi.fn() }));
vi.mock('localforage', () => {
  const items = new Map();
  const clips = new Map();
  const clipStorage = { getItem: async key => clips.get(key), setItem: async (key, value) => clips.set(key, value), clear: async () => clips.clear(), keys: async () => [...clips.keys()], removeItem: async key => clips.delete(key) };
  return { default: { createInstance: () => clipStorage, items, getItem: async (k) => items.get(k) ?? null, setItem: async (k, v) => { items.set(k, v); return v; }, removeItem: async (k) => { items.delete(k); } } };
});

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';
const OTHER_LOG = '2026-08-06--13-00-00';

function route(dongleId, logId) {
  return {
    fullname: `${dongleId}|${logId}`, url: 'https://routes.example.com', create_time: 1,
    segment_start_times: [1000], segment_end_times: [61000], segment_numbers: [0],
    start_time_utc_millis: 1000, end_time_utc_millis: 61000,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function start(url) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const store = createAppStore(history, createInitialState());
  store.dispatch(onLocationChanged(history.location, history.action));
  history.listen((location, action) => store.dispatch(onLocationChanged(location, action)));
  await settle();
  await settle();
  return { history, store };
}

beforeEach(() => {
  api.authenticated = true;
  api.getProfile.mockResolvedValue({ id: 'user', superuser: false });
  api.listDevices.mockResolvedValue([
    { dongle_id: A, is_owner: true, prime: false },
    { dongle_id: B, is_owner: true, prime: false },
  ]);
  api.fetchDevice.mockResolvedValue({ last_athena_ping: 0 });
  api.getRoutesSegments.mockImplementation(async (dongleId, _s, _e, _l, routeStr) => (
    routeStr ? [route(dongleId, routeStr.split('|')[1])] : [route(dongleId, LOG)]
  ));
});

afterEach(() => {
  vi.clearAllMocks();
  webrtcConnectionManager.streamDongleId = null;
  localStorage.clear();
});

describe('one URL → state path', () => {
  it('commits the initial location once and loads its data once', async () => {
    const { store } = await start(`/${A}/${LOG}/10/20`);
    expect(store.getState().nav.generation).toBe(1);
    expect(selectSelectedRouteId(store.getState())).toBe(LOG);
    expect(store.getState().zoom).toEqual({ start: 10000, end: 20000 });
    expect(api.getRoutesSegments).toHaveBeenCalledTimes(1);
  });

  it('applies a plain history push (e.g. a router Link) like any navigation', async () => {
    const { history, store } = await start(`/${A}`);
    history.push(`/${B}/prime`);
    await settle();
    expect(store.getState().dongleId).toBe(B);
    expect(selectView(store.getState())).toBe('prime');
    expect(localStorage.getItem('selectedDongleId')).toBe(B);
  });

  it('keeps zoom, loop and playhead on a query-only change', async () => {
    const { history, store } = await start(`/${A}/${LOG}/10/20`);
    const { zoom, loop } = store.getState();
    const calls = api.getRoutesSegments.mock.calls.length;
    history.push(`/${A}/${LOG}/10/20?ci=1`);
    await settle();
    expect(store.getState().zoom).toBe(zoom);
    expect(store.getState().loop).toBe(loop);
    expect(api.getRoutesSegments).toHaveBeenCalledTimes(calls);
  });

  it('keeps the playhead when a new range still contains it', async () => {
    const { store } = await start(`/${A}/${LOG}/10/40`);
    store.dispatch({ type: 'ACTION_SEEK', offset: 15000 });
    store.dispatch(toDriveRange(A, LOG, 12000, 30000));
    await settle();
    expect(store.getState().zoom).toEqual({ start: 12000, end: 30000 });
    expect(store.getState().offset).toBe(15000);
  });

  it('loops exactly the selection when it widens or returns to the whole drive', async () => {
    const { store } = await start(`/${A}/${LOG}`);
    store.dispatch(toDriveRange(A, LOG, 10000, 20000));
    await settle();
    expect(store.getState().loop).toEqual({ startTime: 10000, duration: 10000 });
    store.dispatch(toDriveRange(A, LOG, 0, 40000));
    await settle();
    expect(store.getState().loop).toEqual({ startTime: 0, duration: 40000 });
    store.dispatch(driveBack());
    await settle();
    expect(store.getState().loop).toEqual({ startTime: 0, duration: 60000 });
    expect(store.getState().zoom).toEqual({ start: 0, end: 60000 });
  });

  it('plays a selection rounded past the end of the drive to the end, without rewriting the URL', async () => {
    api.getRoutesSegments.mockImplementation(async (dongleId) => [{
      ...route(dongleId, LOG), segment_end_times: [61123], end_time_utc_millis: 61123,
    }]);
    const { history, store } = await start(`/${A}/${LOG}`);
    expect(selectCurrentRoute(store.getState()).duration).toBe(60123);
    store.dispatch(toDriveRange(A, LOG, 30000, 60123));
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}/30/61`);
    expect(store.getState().zoom).toEqual({ start: 30000, end: 60123 });
    expect(store.getState().loop).toEqual({ startTime: 30000, duration: 30123 });

    const cold = await start(`/${A}/${LOG}/30/61`);
    expect(cold.history.location.pathname).toBe(`/${A}/${LOG}/30/61`);
    expect(cold.store.getState().zoom).toEqual({ start: 30000, end: 60123 });
  });

  it('a selection after the end of the drive has no effective range and is flagged', async () => {
    const { history, store } = await start(`/${A}/${LOG}/70/80`);
    expect(history.location.pathname).toBe(`/${A}/${LOG}/70/80`);
    expect(selectCurrentRoute(store.getState()).duration).toBe(60000);
    expect(store.getState().zoom).toBeNull();
    expect(store.getState().loop).toBeNull();
    expect(selectSelectionOutOfRange(store.getState())).toBe(true);

    store.dispatch(driveBack());
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}`);
    expect(store.getState().zoom).toEqual({ start: 0, end: 60000 });
    expect(selectSelectionOutOfRange(store.getState())).toBe(false);
  });

  it('rounds a timeline selection outward once and commits exactly the URL', async () => {
    const { history, store } = await start(`/${A}/${LOG}`);
    store.dispatch(toDriveRange(A, LOG, 1234, 5678));
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}/1/6`);
    expect(store.getState().zoom).toEqual({ start: 1000, end: 6000 });
  });

  it.each([
    [`/${A}/`, `/${A}`],
    ['/demo', '/deadbeefdeadbeef'],
  ])('canonicalizes %s with replace and loads once', async (url, canonical) => {
    const { history, store } = await start(url);
    expect(history.location.pathname).toBe(canonical);
    expect(history.length).toBe(1);
    expect(store.getState().dongleId).toBe(canonical.slice(1));
    expect(api.getRoutesSegments).toHaveBeenCalledTimes(1);
  });

  it('shows an invalid location without loading anything', async () => {
    const { store } = await start('/nonsense/abc/def');
    expect(selectView(store.getState())).toBe('invalid');
    expect(api.getRoutesSegments).not.toHaveBeenCalled();
  });
});

describe('history regressions', () => {
  it('Back from Prime onto a drive does not push over the drive URL', async () => {
    const { history, store } = await start(`/${A}/${LOG}`);
    store.dispatch(toPrime(A));
    await settle();
    history.goBack();
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}`);
    expect(history.length).toBe(2);
    expect(selectView(store.getState())).toBe('drive');
  });

  it('a legacy range resolves with replace, so Back does not return to it', async () => {
    const { history } = await start(`/${A}/1000/61000`);
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}`);
    expect(history.length).toBe(1);
  });

  it('a slow legacy lookup does not redirect after the user left', async () => {
    let resolveLookup;
    api.getRoutesSegments.mockImplementation((dongleId, s, e, limit, routeStr) => {
      if (routeStr || limit) return Promise.resolve([route(dongleId, LOG)]);
      return new Promise((resolve) => { resolveLookup = resolve; }); // the legacy lookup
    });
    const { history } = await start(`/${A}/1000/61000`);
    history.push(`/${B}`);
    await settle();
    resolveLookup([route(A, LOG)]);
    await settle();
    expect(history.location.pathname).toBe(`/${B}`);
  });

  it('a stale legacy lookup cannot redirect after A → B → A', async () => {
    const lookups = [];
    api.getRoutesSegments.mockImplementation((dongleId, s, e, l, routeStr) => {
      if (routeStr || l) return Promise.resolve([route(dongleId, LOG)]);
      return new Promise((resolve) => lookups.push(resolve));
    });
    const { history } = await start(`/${A}/1000/61000`);
    history.push(`/${B}`);
    await settle();
    history.goBack();
    await settle();
    lookups[0]([route(A, OTHER_LOG)]); // the first visit's lookup
    await settle();
    expect(history.location.pathname).toBe(`/${A}/1000/61000`);
    lookups[1]([route(A, LOG)]);
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}`);
  });

  it('drive back returns to a verified wider selection, else replaces with the whole drive', async () => {
    const { history, store } = await start(`/${A}/${LOG}`);
    store.dispatch(toDriveRange(A, LOG, 10000, 20000));
    await settle();
    store.dispatch(driveBack());
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}`);
    expect(history.index).toBe(0);

    const cold = await start(`/${A}/${LOG}/10/20`);
    cold.store.dispatch(driveBack());
    await settle();
    expect(cold.history.location.pathname).toBe(`/${A}/${LOG}`);
    expect(cold.history.length).toBe(1);
  });

  it('leaving a page opened in-app goes back; a cold entry pushes the dashboard', async () => {
    const { history, store } = await start(`/${A}/${LOG}`);
    store.dispatch(toPrime(A));
    await settle();
    store.dispatch(leavePage(A));
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}`);

    const cold = await start(`/${A}/prime`);
    cold.store.dispatch(leavePage(A));
    await settle();
    expect(cold.history.location.pathname).toBe(`/${A}`);
    expect(cold.history.length).toBe(2);
  });
});

describe('request identity', () => {
  it('a slow response for drive A cannot select itself after switching to drive B', async () => {
    const pending = {};
    api.getRoutesSegments.mockImplementation((dongleId, s, e, l, routeStr) => new Promise((resolve) => {
      pending[routeStr] = () => resolve([route(dongleId, routeStr.split('|')[1])]);
    }));
    const { history, store } = await start(`/${A}/${LOG}`);
    history.push(`/${A}/${OTHER_LOG}`);
    await settle();
    pending[`${A}|${LOG}`]();
    await settle();
    // drive A's routes must not be applied while drive B is selected
    expect(selectRoutes(store.getState())).toBeNull();
    expect(selectCurrentRoute(store.getState())).toBeNull();
    pending[`${A}|${OTHER_LOG}`]();
    await settle();
    await settle();
    expect(selectCurrentRoute(store.getState())?.log_id).toBe(OTHER_LOG);
  });
});

describe('commands', () => {
  it('consumes the Stripe result, removes it from the URL and still loads the page', async () => {
    const { history, store } = await start(`/${A}/prime?stripe_success=1&ci=1`);
    await settle();
    expect(history.location.search).toBe('?ci=1');
    expect(store.getState().primeStripeResult).toEqual({ success: '1', cancelled: null });
    // the Prime page's own effects still ran (it doesn't need the drive list)
    expect(api.fetchDevice).toHaveBeenCalledWith(A);
    expect(api.getRoutesSegments).not.toHaveBeenCalled();
    expect(localStorage.getItem('selectedDongleId')).toBe(A);
  });

  it('resolves / after consuming a pair token', async () => {
    localStorage.setItem('selectedDongleId', B);
    const { history } = await start('/?pair=token');
    await settle();
    expect(`${history.location.pathname}${history.location.search}`).toBe(`/${B}`);
  });

  it('follows a safe post-login return target, and ignores an external one', async () => {
    const { history } = await start(`/?r=${encodeURIComponent(`/${A}/${LOG}?x=1`)}`);
    expect(`${history.location.pathname}${history.location.search}`).toBe(`/${A}/${LOG}?x=1`);

    api.getRoutesSegments.mockClear();
    const external = await start(`/${A}?r=${encodeURIComponent('//evil.example.com')}`);
    expect(`${external.history.location.pathname}${external.history.location.search}`).toBe(`/${A}`);
    expect(api.getRoutesSegments).toHaveBeenCalled();
  });

  it('resolves / to the remembered device with replace', async () => {
    localStorage.setItem('selectedDongleId', B);
    const { history } = await start('/');
    await settle();
    expect(history.location.pathname).toBe(`/${B}`);
    expect(history.length).toBe(1);
  });
});

// Navigation preserves context while asynchronous work belongs to its initiating session.
describe('navigation and session transitions', () => {
  const url = (history) => `${history.location.pathname}${history.location.search}${history.location.hash}`;

  it('a same-drive range edit keeps unknown arguments (in order) and the hash', async () => {
    const { history, store } = await start(`/${A}/${LOG}?x=one&x=two&ci=1#bookmark`);
    store.dispatch(toDriveRange(A, LOG, 1234, 5678));
    await settle();
    expect(url(history)).toBe(`/${A}/${LOG}/1/6?x=one&x=two&ci=1#bookmark`);
  });

  it('a different page keeps only the global arguments', async () => {
    const { history, store } = await start(`/${A}/${LOG}?x=one&ci=1#bookmark`);
    store.dispatch(toDashboard(B));
    await settle();
    expect(url(history)).toBe(`/${B}?ci=1`);
  });

  it('a queued canonical rewrite cannot overwrite a later navigation', async () => {
    const { history } = await start(`/${A}`);
    history.push(`/${A}/`);
    history.push(`/${B}`);
    await settle(); await settle();
    expect(history.location.pathname).toBe(`/${B}`);
  });

  it('a queued return command cannot redirect after a later navigation', async () => {
    const { history } = await start(`/${A}`);
    history.push(`/${A}?r=${encodeURIComponent(`/${B}`)}`); // canonical, so its effects are queued
    history.push(`/${A}/${LOG}`);
    await settle(); await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}`);
  });

  it('an invalid link runs none of its commands', async () => {
    const { history, store } = await start(`/${A}?r=/${B}&r=/${A}/${LOG}`);
    expect(selectView(store.getState())).toBe('invalid');
    expect(history.location.search).toBe(`?r=/${B}&r=/${A}/${LOG}`);
  });

  it('switching from a loaded drive to another drive fetches it, keeping the list', async () => {
    const { history, store } = await start(`/${A}`);
    const list = selectRoutes(store.getState());
    history.push(`/${A}/${LOG}`);
    await settle();
    expect(selectCurrentRoute(store.getState())?.log_id).toBe(LOG);
    api.getRoutesSegments.mockClear();
    history.push(`/${A}/${OTHER_LOG}`);
    await settle(); await settle();
    expect(api.getRoutesSegments).toHaveBeenCalledWith(A, undefined, undefined, undefined, `${A}|${OTHER_LOG}`);
    expect(selectCurrentRoute(store.getState())?.log_id).toBe(OTHER_LOG);
    expect(selectRoutes(store.getState())).toBe(list);
    expect(store.getState().entities.routes[`${A}|${OTHER_LOG}`].log_id).toBe(OTHER_LOG);
  });

  it('a drive that does not exist is reported once, without retrying', async () => {
    api.getRoutesSegments.mockImplementation(async (dongleId, _s, _e, _l, routeStr) => (routeStr ? [] : [route(dongleId, LOG)]));
    const { history, store } = await start(`/${A}`);
    history.push(`/${A}/${OTHER_LOG}`);
    await settle(); await settle();
    expect(selectSelectedRouteMissing(store.getState())).toBe(true);
    const calls = api.getRoutesSegments.mock.calls.length;
    store.dispatch(checkRoutesData());
    await settle();
    expect(api.getRoutesSegments).toHaveBeenCalledTimes(calls);
  });

  it('A → B → A reuses the identical list request still in flight', async () => {
    const answers = [];
    api.getRoutesSegments.mockImplementation((dongleId) => new Promise((resolve) => answers.push({ dongleId, resolve })));
    const { history, store } = await start(`/${A}`);
    history.push(`/${B}`); await settle();
    history.push(`/${A}`); await settle();
    expect(answers).toHaveLength(2);
    answers[0].resolve([route(A, LOG)]); await settle();
    expect(selectRoutes(store.getState()).map((r) => r.log_id)).toEqual([LOG]);
    answers[1].resolve([route(B, OTHER_LOG)]); await settle();
    expect(selectRoutes(store.getState()).map((r) => r.log_id)).toEqual([LOG]);
  });

  it('a reused old detail request cannot redirect a newer visit to login', async () => {
    api.authenticated = false;
    const answers = [];
    api.getRoutesSegments.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const { history, store } = await start(`/${A}/${LOG}`);
    history.push(`/${B}/${LOG}`); await settle();
    history.push(`/${A}/${LOG}`); await settle();
    expect(answers).toHaveLength(2);
    answers[0]([]); await settle();
    expect(hardNavigate).not.toHaveBeenCalled();
    expect(selectSelectedRouteMissing(store.getState())).toBe(true);
  });

  it('ending the session clears private state and ignores late results from it', async () => {
    let finishProfile;
    let finishDevices;
    api.getProfile.mockImplementation(() => new Promise((resolve) => { finishProfile = resolve; }));
    api.listDevices.mockImplementation(() => new Promise((resolve) => { finishDevices = resolve; }));
    const { store } = await start(`/${A}`);
    store.dispatch(endSession());
    finishProfile({ id: 'old-user' });
    finishDevices([{ dongle_id: A, is_owner: true }]);
    await settle(); await settle();
    expect(store.getState().profile).toBeNull();
    expect(selectDevices(store.getState())).toBeNull();

    // any result started before the end carries the old epoch
    store.dispatch({ type: Types.ACTION_PRIME_SUBSCRIPTION, dongleId: A, subscription: { old: true }, epoch: 0 });
    expect(store.getState().queries.subscriptions).toEqual({});
  });

  it('a fresh bootstrap after the session ended does not reuse the old one', async () => {
    const { store } = await start(`/${A}`);
    expect(store.getState().profile).toEqual({ id: 'user', superuser: false });
    store.dispatch(endSession());
    expect(store.getState().profile).toBeNull();
    api.getProfile.mockResolvedValue({ id: 'next-user' });
    await store.dispatch(bootstrapSession());
    expect(store.getState().profile).toEqual({ id: 'next-user' });
  });

  it('upload results belong to the device they were started for', async () => {
    const { history, store } = await start(`/${A}`);
    history.push(`/${B}`);
    await settle();
    store.dispatch(updateFiles({ [`${A}|${LOG}--0/cameras`]: { progress: 0 } }, A));
    expect(selectFiles(store.getState())).toBeNull();
    expect(store.getState().entities.files[`${A}|${LOG}--0/cameras`]).toEqual({ progress: 0 });
  });

  it('a pair token arriving by URL later in the session is stored and handed over', async () => {
    const { history, store } = await start(`/${A}`);
    history.push(`/${A}?pair=token-1`);
    await settle(); await settle();
    expect(localforage.items.get('pairToken')).toBe('token-1');
    expect(store.getState().pairRequests).toBe(1);
    expect(history.location.search).toBe('');
  });

  it('the stream page reports enter, leave and device changes to the connection manager', async () => {
    api.listDevices.mockResolvedValue([
      { dongle_id: A, is_owner: true, prime: false, rpc: { not_car: true } }, // a comma body
      { dongle_id: B, is_owner: true, prime: false },
    ]);
    const { history } = await start(`/${A}/stream`);
    expect(webrtcConnectionManager.enterStream).toHaveBeenCalledWith(A);
    history.push(`/${A}`);
    await settle();
    expect(webrtcConnectionManager.leaveStream).toHaveBeenCalledWith(A, { keepWarm: true });
    history.push(`/${B}/stream`);
    await settle();
    expect(webrtcConnectionManager.deviceChanged).toHaveBeenCalledWith(B);
    history.push(`/${B}`);
    await settle();
    expect(webrtcConnectionManager.leaveStream).toHaveBeenLastCalledWith(B, { keepWarm: false }); // a car
  });

  it('crossing between the demo and real backends reloads the page', async () => {
    api.backendType = 'real';
    try {
      const { history } = await start(`/${A}`);
      history.push('/deadbeefdeadbeef');
      await settle();
      expect(hardNavigate).toHaveBeenCalledWith('/deadbeefdeadbeef');
    } finally {
      api.backendType = null;
    }
  });

  it('root resolution keeps the global arguments and hash; legacy keeps everything', async () => {
    localStorage.setItem('selectedDongleId', B);
    const root = await start('/?ci=1#bookmark');
    expect(url(root.history)).toBe(`/${B}?ci=1#bookmark`);

    const legacy = await start(`/${A}/1000/61000?x=one&x=two&ci=1#bookmark`);
    await settle();
    expect(url(legacy.history)).toBe(`/${A}/${LOG}?x=one&x=two&ci=1#bookmark`);
  });
});

// The connection manager decides whether a released stream stays warm.
describe('same-page navigation ownership', () => {
  it('a queued canonical rewrite preserves a newer same-page hash navigation', async () => {
    const { history } = await start(`/${A}`);
    history.push(`/${A}/`);
    history.push(`/${A}#new`);
    await settle(); await settle();
    expect(history.location.hash).toBe('#new');
  });

  it('...and the page still loads (the deferred effects are not lost)', async () => {
    const { history, store } = await start(`/${B}`);
    api.getRoutesSegments.mockClear();
    history.push(`/${A}/`);
    history.push(`/${A}#new`);
    await settle(); await settle();
    expect(store.getState().dongleId).toBe(A);
    expect(api.getRoutesSegments).toHaveBeenCalled();
  });

  it('rapid stream exit releases even when its first queued effect is superseded', async () => {
    const { history } = await start(`/${A}/stream`);
    webrtcConnectionManager.leaveStream.mockClear();
    history.push(`/${A}`);
    history.push(`/${A}/${LOG}`);
    await settle(); await settle();
    expect(webrtcConnectionManager.leaveStream).toHaveBeenCalledWith(A, expect.anything());
  });

  it('a command token already consumed in this session is not consumed again after another token', async () => {
    const { history, store } = await start(`/${A}`);
    for (const token of ['token-1', 'token-2', 'token-1']) {
      history.push(`/${A}?pair=${token}`);
      // one navigation at a time, on purpose
      // eslint-disable-next-line no-await-in-loop
      await settle(); await settle();
    }
    expect(store.getState().pairRequests).toBe(2);
  });

  it('a late rejected bootstrap cannot end a newer session', async () => {
    let rejectOld;
    api.getProfile.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const { store } = await start(`/${A}`);
    store.dispatch(endSession());
    api.getProfile.mockResolvedValue({ id: 'new-user' });
    await store.dispatch(bootstrapSession());
    expect(store.getState().profile.id).toBe('new-user');
    rejectOld({ resp: { status: 401 } });
    await settle(); await settle();
    expect(store.getState().profile?.id).toBe('new-user');
    expect(store.getState().sessionEpoch).toBe(1);
  });

  it('a range edit preserves elapsed playing position inside the new bounds', async () => {
    const { store } = await start(`/${A}/${LOG}`);
    const t = 1900000000000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t);
    try {
      store.dispatch(seek(0));
      store.dispatch(bufferVideo(false));
      now.mockReturnValue(t + 15000);
      expect(currentOffset(store.getState())).toBe(15000);
      store.dispatch(toDriveRange(A, LOG, 10000, 20000));
      await settle();
      expect(currentOffset(store.getState())).toBe(15000);
    } finally { now.mockRestore(); }
  });

  it('a forced same-query refresh wins even when the old response arrives first', async () => {
    const answers = [];
    api.getRoutesSegments.mockImplementation((dongleId) => new Promise((resolve) => answers.push({ dongleId, resolve })));
    const { store } = await start(`/${A}`);
    store.dispatch(checkRoutesData({ force: true })); await settle();
    answers[0].resolve([route(A, LOG)]); await settle();
    expect(selectRoutes(store.getState())).toBeNull();
    answers[1].resolve([route(A, OTHER_LOG)]); await settle();
    expect(selectRoutes(store.getState()).map((r) => r.log_id)).toEqual([OTHER_LOG]);
  });
});

describe('task dialogs', () => {
  const settings = (dongleId, panel = null) => modalOf(MODALS.SETTINGS, { dongleId, panel });
  const url = (history) => `${history.location.pathname}${history.location.search}`;

  it('opening settings for another device over a drive keeps the drive untouched', async () => {
    const { history, store } = await start(`/${A}/${LOG}/10/20`);
    const { zoom, loop, nav } = store.getState();
    const currentRoute = selectCurrentRoute(store.getState());
    const calls = api.getRoutesSegments.mock.calls.length;
    store.dispatch(openModal(settings(B)));
    await settle();
    expect(url(history)).toBe(`/${A}/${LOG}/10/20?modal=settings&modalDevice=${B}`);
    expect(store.getState().dongleId).toBe(A);
    expect(store.getState().zoom).toBe(zoom);
    expect(store.getState().loop).toBe(loop);
    expect(selectCurrentRoute(store.getState())).toBe(currentRoute);
    expect(store.getState().nav.generation).toBe(nav.generation);
    expect(api.getRoutesSegments).toHaveBeenCalledTimes(calls);

    store.dispatch(closeModal());
    await settle();
    expect(url(history)).toBe(`/${A}/${LOG}/10/20`);
    expect(history.index).toBe(0);
    expect(store.getState().zoom).toBe(zoom);
  });

  it('browser Back closes a dialog and Forward reopens it', async () => {
    const { history, store } = await start(`/${A}`);
    store.dispatch(openModal(settings(A)));
    await settle();
    expect(url(history)).toBe(`/${A}/settings`);
    history.goBack();
    await settle();
    expect(selectNavLocation(store.getState()).modal).toBeNull();
    history.goForward();
    await settle();
    expect(selectNavLocation(store.getState()).modal).toMatchObject({ kind: 'settings', dongleId: A });
  });

  it('a directly loaded dialog closes to its page with replace', async () => {
    const { history, store } = await start(`/${A}/settings`);
    store.dispatch(closeModal());
    await settle();
    expect(url(history)).toBe(`/${A}`);
    expect(history.length).toBe(1);
  });

  it('the uploads panel closes to settings, and settings to the page', async () => {
    const { history, store } = await start(`/${A}`);
    store.dispatch(openModal(settings(A)));
    await settle();
    store.dispatch(openModal(settings(A, 'uploads')));
    await settle();
    expect(url(history)).toBe(`/${A}/settings/uploads`);
    store.dispatch(closeModal());
    await settle();
    expect(url(history)).toBe(`/${A}/settings`);
    store.dispatch(closeModal());
    await settle();
    expect(url(history)).toBe(`/${A}`);
    expect(history.index).toBe(0);

    const direct = await start(`/${A}/settings/uploads`);
    direct.store.dispatch(closeModal());
    await settle();
    expect(url(direct.history)).toBe(`/${A}/settings`);
  });

  it('uploads opened straight from a drive close back to that drive', async () => {
    const { history, store } = await start(`/${A}/${LOG}`);
    store.dispatch(openModal(settings(A, 'uploads')));
    await settle();
    expect(url(history)).toBe(`/${A}/${LOG}?modal=settings&panel=uploads`);
    store.dispatch(closeModal());
    await settle();
    expect(url(history)).toBe(`/${A}/${LOG}`);
  });

  it('the add-device link resolves to the remembered dashboard and keeps the dialog', async () => {
    localStorage.setItem('selectedDongleId', B);
    const { history, store } = await start('/devices/add');
    await settle();
    expect(url(history)).toBe(`/${B}?modal=add-device`);
    expect(history.length).toBe(1);
    expect(selectNavLocation(store.getState()).modal).toMatchObject({ kind: 'add-device' });
  });

  it('an invalid dialog link shows the invalid page without loading', async () => {
    const { store } = await start(`/${A}/stream?modal=settings`);
    expect(selectView(store.getState())).toBe('invalid');
    expect(api.getRoutesSegments).not.toHaveBeenCalled();
  });
});

describe('dialog history and polling', () => {
  const settings = (dongleId, panel = null) => modalOf(MODALS.SETTINGS, { dongleId, panel });
  const url = (history) => `${history.location.pathname}${history.location.search}${history.location.hash}`;

  it('a dialog opened from a page that cannot host it opens on its direct link', async () => {
    api.getRoutesSegments.mockImplementation(async (dongleId, s, e, l, routeStr) => (routeStr || l ? [route(dongleId, LOG)] : []));
    const legacy = await start(`/${A}/1000/61000`); // lookup came back empty: stays on the legacy page
    await settle();
    expect(selectView(legacy.store.getState())).toBe('legacyRange');
    legacy.store.dispatch(openModal(settings(A)));
    await settle();
    expect(url(legacy.history)).toBe(`/${A}/settings`);
    legacy.store.dispatch(openModal(modalOf(MODALS.ADD_DEVICE)));
    await settle();
    expect(url(legacy.history)).toBe(`/${A}?modal=add-device`);

    const notFound = await start('/nonsense');
    notFound.store.dispatch(openModal(settings(B)));
    await settle();
    expect(url(notFound.history)).toBe(`/${B}/settings`);
  });

  it('opening and closing a dialog keeps unknown arguments and the hash', async () => {
    const { history, store } = await start(`/${A}/${LOG}?foo=1#h`);
    store.dispatch(openModal(settings(A)));
    await settle();
    expect(url(history)).toBe(`/${A}/${LOG}?modal=settings&foo=1#h`);
    store.dispatch(closeModal());
    await settle();
    expect(url(history)).toBe(`/${A}/${LOG}?foo=1#h`);
  });

  it('only a click in this session counts as opening a dialog interactively', async () => {
    const { history, store } = await start(`/${A}`);
    store.dispatch(openModal(modalOf(MODALS.ADD_DEVICE)));
    await settle();
    expect(store.dispatch(openedInteractively())).toBe(true);
    history.goBack();
    await settle();
    history.goForward();
    await settle();
    expect(selectNavLocation(store.getState()).modal).toMatchObject({ kind: 'add-device' });
    expect(store.dispatch(openedInteractively())).toBe(false);
  });

  it('upload queue polling stops only when its last owner lets go', async () => {
    const { store } = await start(`/${A}`);
    const menu = {};
    const dialog = {};
    store.dispatch(pollUploadQueue(menu, A));
    store.dispatch(pollUploadQueue(dialog, A));
    store.dispatch(stopPollingUploadQueue(dialog));
    expect(store.dispatch(uploadQueuePollers())).toBe(1);
    store.dispatch(stopPollingUploadQueue(menu));
    expect(store.dispatch(uploadQueuePollers())).toBe(0);

    // owners belong to their store
    const other = await start(`/${A}`);
    expect(other.store.dispatch(uploadQueuePollers())).toBe(0);
  });
});

describe('dialog results belong to their session and navigation', () => {
  it('a rename answered after logout does not reinstall the device', async () => {
    let answer;
    api.setDeviceAlias.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { store } = await start(`/${A}`);
    const rename = store.dispatch(renameDevice(A, 'Renamed'));
    store.dispatch(endSession());
    answer({ dongle_id: A, alias: 'Renamed', is_owner: true });
    await rename;
    expect(selectDevices(store.getState())).toBeNull();
  });

  it('a Stripe redirect answered after the user left the page does not leave the app', async () => {
    let answer;
    const { history, store } = await start(`/${A}/prime`);
    const leaving = store.dispatch(leaveForExternalUrl(() => new Promise((resolve) => { answer = resolve; })));
    history.push(`/${A}`);
    await settle();
    answer('https://billing.stripe.com/session');
    expect(await leaving).toBe(false);
    expect(hardNavigate).not.toHaveBeenCalled();
  });
});

describe('adversarial task destination ownership', () => {
  it('an external task completion cannot leave after another dialog became current', async () => {
    let answer;
    const { store } = await start(`/${A}/prime`);
    const pending = store.dispatch(leaveForExternalUrl(() => new Promise(resolve => { answer = resolve; })));
    store.dispatch(openModal(modalOf(MODALS.SETTINGS, { dongleId: A })));
    await settle();
    answer('https://billing.stripe.com/old-task');
    expect(await pending).toBe(false);
    expect(hardNavigate).not.toHaveBeenCalled();
  });
});

describe('devices are stored once, by id', () => {
  it('a rename shows everywhere and keeps RPC-fetched values', async () => {
    const { store } = await start(`/${A}`);
    store.dispatch({ type: Types.ACTION_UPDATE_DEVICE_RPC, dongleId: A, fields: { not_car: true } });
    store.dispatch(updateDevice({ dongle_id: A, alias: 'Renamed' }));
    const device = selectDevice(store.getState());
    expect(device.alias).toBe('Renamed');
    expect(device.rpc).toEqual({ not_car: true });
    expect(selectDevices(store.getState()).find((d) => d.dongle_id === A)).toBe(device);
  });

  it('a refreshed device list keeps RPC-fetched values', async () => {
    const { store } = await start(`/${A}`);
    store.dispatch({ type: Types.ACTION_UPDATE_DEVICE_RPC, dongleId: A, fields: { not_car: true } });
    store.dispatch(updateDevices([{ dongle_id: A, alias: 'From list', is_owner: true }]));
    expect(selectDevice(store.getState())).toMatchObject({ alias: 'From list', rpc: { not_car: true } });
  });

  it('selectors return the same objects across unrelated actions', async () => {
    const { store } = await start(`/${A}/${LOG}`);
    const devices = selectDevices(store.getState());
    const device = selectDevice(store.getState());
    store.dispatch({ type: 'ACTION_SEEK', offset: 1000 }); // a playback tick
    expect(selectDevices(store.getState())).toBe(devices);
    expect(selectDevice(store.getState())).toBe(device);
  });

  it('A -> B -> A reuses the stored device without refetching the list', async () => {
    const { history, store } = await start(`/${A}`);
    store.dispatch({ type: Types.ACTION_UPDATE_DEVICE_RPC, dongleId: A, fields: { not_car: true } });
    history.push(`/${B}`);
    await settle();
    expect(selectDevice(store.getState()).dongle_id).toBe(B);
    history.push(`/${A}`);
    await settle();
    // only its online status is refreshed (deliberately, on selection)
    expect(selectDevice(store.getState())).toMatchObject({ dongle_id: A, rpc: { not_car: true } });
    expect(api.listDevices).toHaveBeenCalledTimes(1);
  });

  it('a device paired after startup is treated as listed, not shared', async () => {
    const PAIRED = 'cccccccccccccccc';
    const { history, store } = await start(`/${A}`);
    store.dispatch(updateDevices([
      { dongle_id: A, is_owner: true, prime: false },
      { dongle_id: PAIRED, alias: 'New', is_owner: true, prime: true },
    ]));
    api.fetchDevice.mockResolvedValue({ last_athena_ping: 5 });
    history.push(`/${PAIRED}`);
    await settle();
    await settle();
    expect(billing.getSubscription).toHaveBeenCalledWith(PAIRED);
    expect(selectDevice(store.getState())).toMatchObject({
      dongle_id: PAIRED, alias: 'New', is_owner: true, shared: false, last_athena_ping: 5,
    });
  });

  it('a fetched shared device keeps what was already known about it', async () => {
    const SHARED = 'cccccccccccccccc';
    const { store } = await start(`/${A}`);
    store.dispatch({ type: Types.ACTION_UPDATE_DEVICE_RPC, dongleId: SHARED, fields: { not_car: true } });
    store.dispatch({ type: Types.ACTION_UPDATE_SHARED_DEVICE, dongleId: SHARED, device: { alias: 'Shared' } });
    expect(store.getState().entities.devices[SHARED]).toMatchObject({ alias: 'Shared', rpc: { not_car: true } });
  });

  it('a shared device not in the list is a placeholder until fetched, then stored', async () => {
    const SHARED = 'cccccccccccccccc';
    api.fetchDevice.mockResolvedValue({ dongle_id: SHARED, alias: 'Shared', is_owner: false, last_athena_ping: 0 });
    const { store } = await start(`/${SHARED}`);
    await settle();
    expect(selectDevice(store.getState())).toMatchObject({ dongle_id: SHARED, alias: 'Shared' });
  });
});
