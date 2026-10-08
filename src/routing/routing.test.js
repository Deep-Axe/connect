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
import { selectSelectedRouteId, selectView } from './selectors';
import { driveBack, leavePage, toDriveRange, toPrime } from './navigate';

const api = vi.hoisted(() => ({
  authenticated: true,
  getRoutesSegments: vi.fn(),
  listDevices: vi.fn(),
  getProfile: vi.fn(),
  fetchDevice: vi.fn(),
}));

vi.mock('../api/backend', () => ({
  api: {
    auth: { isAuthenticated: () => api.authenticated, logOut: vi.fn() },
    account: { getProfile: api.getProfile },
    devices: { listDevices: api.listDevices, fetchDevice: api.fetchDevice },
    routes: { getRoutesSegments: api.getRoutesSegments },
  },
}));
vi.mock('../api', () => ({
  athena: {}, billing: { getSubscribeInfo: vi.fn(async () => null), getSubscription: vi.fn(async () => null) },
}));
vi.mock('../utils/webrtc', () => ({ webrtcConnectionManager: { disconnect: vi.fn(), reconnect: vi.fn() } }));
vi.mock('../utils/navigation', () => ({ hardNavigate: vi.fn() }));

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
    expect(store.getState().currentRoute.duration).toBe(60123);
    store.dispatch(toDriveRange(A, LOG, 30000, 60123));
    await settle();
    expect(history.location.pathname).toBe(`/${A}/${LOG}/30/61`);
    expect(store.getState().zoom).toEqual({ start: 30000, end: 60123 });
    expect(store.getState().loop).toEqual({ startTime: 30000, duration: 30123 });

    const cold = await start(`/${A}/${LOG}/30/61`);
    expect(cold.history.location.pathname).toBe(`/${A}/${LOG}/30/61`);
    expect(cold.store.getState().zoom).toEqual({ start: 30000, end: 60123 });
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
    expect(store.getState().routes).toBeNull();
    expect(store.getState().currentRoute).toBeNull();
    pending[`${A}|${OTHER_LOG}`]();
    await settle();
    await settle();
    expect(store.getState().currentRoute?.log_id).toBe(OTHER_LOG);
  });
});

describe('commands', () => {
  it('consumes the Stripe result, removes it from the URL and still loads the page', async () => {
    const { history, store } = await start(`/${A}/prime?stripe_success=1&ci=1`);
    await settle();
    expect(history.location.search).toBe('?ci=1');
    expect(store.getState().primeStripeResult).toEqual({ success: '1', cancelled: null });
    expect(api.getRoutesSegments).toHaveBeenCalled();
    expect(api.fetchDevice).toHaveBeenCalledWith(A);
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
