// URL in → state out, through the real store, reducers and middleware. The
// memory history is wired to the store exactly as ConnectedRouter does it:
// the initial location is dispatched once, then every history change.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'history';
import { LOCATION_CHANGE } from 'connected-react-router';

// the action ConnectedRouter dispatches for every location

const onLocationChanged = (location, action) => ({
  type: LOCATION_CHANGE,
  payload: {
    location,
    action
  }
});
import { createInitialState } from '../initialState';
import { createAppStore } from '../store';
import localforage from 'localforage';
import { webrtcConnectionManager } from '../utils/webrtc';
import { endSession } from '../actions/session';

const api = vi.hoisted(() => ({
  authenticated: true,
  backendType: null,
  getRoutesSegments: vi.fn(),
  listDevices: vi.fn(),
  getProfile: vi.fn(),
  fetchDevice: vi.fn()
}));

vi.mock('../api/backend', () => ({
  activeBackendType: () => api.backendType,
  selectBackendType: pathname => pathname.startsWith('/deadbeefdeadbeef') || pathname.startsWith('/demo') ? 'demo' : 'real',
  api: {
    auth: {
      isAuthenticated: () => api.authenticated,
      logOut: vi.fn()
    },
    account: {
      getProfile: api.getProfile
    },
    devices: {
      listDevices: api.listDevices,
      fetchDevice: api.fetchDevice
    },
    routes: {
      getRoutesSegments: api.getRoutesSegments
    }
  }
}));

vi.mock('../api', () => ({
  request: {
    configure: vi.fn()
  },
  athena: {
    configure: vi.fn()
  },
  billing: {
    configure: vi.fn(),
    getSubscribeInfo: vi.fn(async () => null),
    getSubscription: vi.fn(async () => null)
  }
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
    enterStream: vi.fn(dongleId => {
      manager.streamDongleId = dongleId;
    }),
    leaveStream: vi.fn(dongleId => {
      if (manager.streamDongleId === dongleId) manager.streamDongleId = null;
    })
  };
  return {
    webrtcConnectionManager: manager
  };
});

vi.mock('../utils/navigation', () => ({
  hardNavigate: vi.fn()
}));

vi.mock('localforage', () => {
  const items = new Map();
  const clips = new Map();
  const clipStorage = {
    getItem: async key => clips.get(key),
    setItem: async (key, value) => clips.set(key, value),
    clear: async () => clips.clear(),
    keys: async () => [...clips.keys()],
    removeItem: async key => clips.delete(key)
  };
  return {
    default: {
      createInstance: () => clipStorage,
      items,
      getItem: async k => items.get(k) ?? null,
      setItem: async (k, v) => {
        items.set(k, v);
        return v;
      },
      removeItem: async k => {
        items.delete(k);
      }
    }
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
    end_time_utc_millis: 61000
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function start(url) {
  const history = createMemoryHistory({
    initialEntries: [url]
  });
  const store = createAppStore(history, createInitialState());
  store.dispatch(onLocationChanged(history.location, history.action));
  history.listen((location, action) => store.dispatch(onLocationChanged(location, action)));
  await settle();
  await settle();
  return {
    history,
    store
  };
}

beforeEach(() => {
  api.authenticated = true;
  api.getProfile.mockResolvedValue({
    id: 'user',
    superuser: false
  });
  api.listDevices.mockResolvedValue([{
    dongle_id: A,
    is_owner: true,
    prime: false
  }, {
    dongle_id: B,
    is_owner: true,
    prime: false
  }]);
  api.fetchDevice.mockResolvedValue({
    last_athena_ping: 0
  });
  api.getRoutesSegments.mockImplementation(async (dongleId, _s, _e, _l, routeStr) => routeStr ? [route(dongleId, routeStr.split('|')[1])] : [route(dongleId, LOG)]);
});

afterEach(() => {
  vi.clearAllMocks();
  webrtcConnectionManager.streamDongleId = null;
  localStorage.clear();
});

it('late pair-command persistence cannot install a token after session teardown', async () => {
  let complete;
  vi.spyOn(localforage, 'setItem').mockImplementationOnce((key, value) => new Promise(resolve => {
    complete = () => {
      localforage.items.set(key, value);
      resolve(value);
    };
  }));
  const app = await start(`/${A}?pair=late-old-token`);
  app.store.dispatch(endSession());
  complete();
  await settle();
  expect(localforage.items.get('pairToken')).not.toBe('late-old-token');
  expect(app.store.getState().pairRequests).toBe(0);
});

it('a repeated in-flight pair command shares persistence and hands over once', async () => {
  let complete;
  vi.spyOn(localforage, 'setItem').mockImplementationOnce((key, value) => new Promise(resolve => {
    complete = () => {
      localforage.items.set(key, value);
      resolve(value);
    };
  }));
  const app = await start(`/${A}?pair=repeat-token`);
  app.history.push(`/${A}?pair=repeat-token&extension=new#kept`);
  await settle();
  complete();
  await settle();
  await settle();
  expect(app.store.getState().pairRequests).toBe(1);
  expect(localforage.items.get('pairToken')).toBe('repeat-token');
  expect(app.history.location.search).toBe('?extension=new');
  expect(app.history.location.hash).toBe('#kept');
});

it('logout cleanup cannot delete a successor session token behind an old write', async () => {
  let complete;
  vi.spyOn(localforage, 'setItem').mockImplementationOnce((key, value) => new Promise(resolve => {
    complete = () => {
      localforage.items.set(key, value);
      resolve(value);
    };
  }));
  const app = await start(`/${A}?pair=old-token`);
  app.store.dispatch(endSession());
  app.history.push(`/${A}?pair=fresh-token`);
  await settle();
  complete();
  await settle();
  await settle();
  expect(localforage.items.get('pairToken')).toBe('fresh-token');
  expect(app.store.getState().pairRequests).toBe(1);
});
