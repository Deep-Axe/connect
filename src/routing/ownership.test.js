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
import localforage from 'localforage';
import { webrtcConnectionManager } from '../utils/webrtc';
import { endSession } from '../actions/session';
import { selectView } from './selectors';
import { selectDevices } from '../selectors';
import { buildUrl, parseLocation, VIEWS } from './codec';

const api = vi.hoisted(() => ({
  authenticated: true,
  backendType: null,
  getRoutesSegments: vi.fn(),
  listDevices: vi.fn(),
  getProfile: vi.fn(),
  fetchDevice: vi.fn(),
}));

vi.mock('../api/backend', () => ({
  activeBackendType: () => api.backendType,
  selectBackendType: (pathname) =>
    pathname.startsWith('/deadbeefdeadbeef') || pathname.startsWith('/demo') ? 'demo' : 'real',
  api: {
    auth: { isAuthenticated: () => api.authenticated, logOut: vi.fn() },
    account: { getProfile: api.getProfile },
    devices: { listDevices: api.listDevices, fetchDevice: api.fetchDevice },
    routes: { getRoutesSegments: api.getRoutesSegments },
  },
}));

vi.mock('../api', () => ({
  request: { configure: vi.fn() },
  athena: { configure: vi.fn() },
  billing: { configure: vi.fn(), getSubscribeInfo: vi.fn(async () => null), getSubscription: vi.fn(async () => null) },
}));

vi.mock('../utils/webrtc', () => {
  // tracks which device's stream page holds the connection, like the real one
  const manager = {
    streamDongleId: null,
    disconnect: vi.fn(() => {
      manager.streamDongleId = null;
    }),
    reconnect: vi.fn(),
    deviceChanged: vi.fn(),
    enterStream: vi.fn((dongleId) => {
      manager.streamDongleId = dongleId;
    }),
    leaveStream: vi.fn((dongleId) => {
      if (manager.streamDongleId === dongleId) manager.streamDongleId = null;
    }),
  };
  return { webrtcConnectionManager: manager };
});

vi.mock('../utils/navigation', () => ({ hardNavigate: vi.fn() }));

vi.mock('localforage', () => {
  const items = new Map();
  const clips = new Map();
  const clipStorage = {
    getItem: async (key) => clips.get(key),
    setItem: async (key, value) => clips.set(key, value),
    clear: async () => clips.clear(),
    keys: async () => [...clips.keys()],
    removeItem: async (key) => clips.delete(key),
  };
  return {
    default: {
      createInstance: () => clipStorage,
      items,
      getItem: async (k) => items.get(k) ?? null,
      setItem: async (k, v) => {
        items.set(k, v);
        return v;
      },
      removeItem: async (k) => {
        items.delete(k);
      },
    },
  };
});

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';

function route(dongleId, logId) {
  return {
    fullname: `${dongleId}|${logId}`,
    url: 'https://routes.example.com',
    create_time: 1,
    segment_start_times: [1000],
    segment_end_times: [61000],
    segment_numbers: [0],
    start_time_utc_millis: 1000,
    end_time_utc_millis: 61000,
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
  api.getRoutesSegments.mockImplementation(async (dongleId, _s, _e, _l, routeStr) =>
    routeStr ? [route(dongleId, routeStr.split('|')[1])] : [route(dongleId, LOG)],
  );
});

afterEach(() => {
  vi.clearAllMocks();
  webrtcConnectionManager.streamDongleId = null;
  localStorage.clear();
});

describe('navigation supersession', () => {
  it('all recognized commands survive a login-return redirect', async () => {
    const target = `/${A}/${LOG}/0/20`;
    const app = await start(`/?r=${encodeURIComponent(target)}&pair=combine-token`);
    await settle();
    expect(app.history.location.pathname).toBe(target);
    expect(localforage.items.get('pairToken')).toBe('combine-token');
    expect(app.store.getState().pairRequests).toBe(1);
  });

  it('root fallback uses first sorted accessible device', async () => {
    api.listDevices.mockResolvedValue([
      { dongle_id: A, is_owner: true, alias: 'Zulu' },
      { dongle_id: B, is_owner: true, alias: 'Alpha' },
    ]);
    const app = await start('/');
    expect(selectDevices(app.store.getState())[0].dongle_id).toBe(B);
    expect(app.history.location.pathname).toBe(`/${B}`);
  });

  it('stream -> invalid releases its lifecycle ownership', async () => {
    const app = await start(`/${A}/stream`);
    expect(webrtcConnectionManager.streamDongleId).toBe(A);
    app.history.push('/not-a-real-route');
    await settle();
    expect(selectView(app.store.getState())).toBe(VIEWS.INVALID);
    expect(webrtcConnectionManager.streamDongleId).toBeNull();
  });

  it('logout while streaming releases runtime ownership', async () => {
    const app = await start(`/${A}/stream`);
    app.store.dispatch(endSession());
    await settle();
    expect(app.store.getState().profile).toBeNull();
    expect(webrtcConnectionManager.streamDongleId).toBeNull();
  });

  it('auth path rejects unexpected suffixes', () => {
    expect(parseLocation({ pathname: '/auth/unrecognized/extra' }).base.view).toBe(VIEWS.INVALID);
    expect(parseLocation({ pathname: '/auth//' }).base.view).toBe(VIEWS.INVALID);
  });

  it('duplicate callback commands cannot exchange auth', () => {
    expect(parseLocation({ pathname: '/auth/', search: '?code=first&code=second&provider=h' }).base.view).toBe(
      VIEWS.INVALID,
    );
  });

  it('valid zero start and ordered extension pairs roundtrip', () => {
    const input = { pathname: `/${A}/${LOG}/0/20`, search: '?x=1&x=2', hash: '#keep' };
    expect(buildUrl(parseLocation(input))).toBe(`/${A}/${LOG}/0/20?x=1&x=2#keep`);
  });

  it('legacy builder validates ordered positive safe bounds', () => {
    expect(() =>
      buildUrl({ base: { view: VIEWS.LEGACY_RANGE, dongleId: A, legacyRange: { start: 4, end: 3 } } }),
    ).toThrow('invalid legacy range');
  });

  it('removed return command cannot rewrite a newer query-only location', async () => {
    const app = await start(`/${A}/${LOG}/0/20`);
    app.history.push(`/${A}/${LOG}/0/20?r=${encodeURIComponent('/' + B)}`);
    app.history.push(`/${A}/${LOG}/0/20?newer=keep#anchor`);
    await settle();
    await settle();
    expect(app.history.location.pathname).toBe(`/${A}/${LOG}/0/20`);
    expect(app.history.location.search).toBe('?newer=keep');
    expect(app.history.location.hash).toBe('#anchor');
  });
});

it('session teardown invalidates a deferred canonical rewrite', async () => {
  const app = await start(`/${A}/${LOG}/0/20`);
  app.history.push(`/${A}/prime/`);
  app.store.dispatch(endSession());
  await settle();
  expect(app.history.location.pathname).toBe(`/${A}/prime/`);
});

it('a selected-device bootstrap finishing after logout cannot start successor resource work', async () => {
  let resolve;
  api.listDevices.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  const app = await start(`/${A}`);
  const calls = api.fetchDevice.mock.calls.length;
  app.store.dispatch(endSession());
  resolve([{ dongle_id: A, is_owner: true }]);
  await settle();
  await settle();
  expect(api.fetchDevice).toHaveBeenCalledTimes(calls);
});
