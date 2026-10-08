import { beforeEach, expect, it, vi } from 'vitest';
import { createRoutingServices } from '../routing/services';
import { Media } from './DriveView/Media';
import { PrimeManage } from './Prime/PrimeManage';
import { ExplorerApp } from './explorer';

const mocks = vi.hoisted(() => ({
  urls: vi.fn(),
  upload: vi.fn(),
  info: vi.fn(),
  switchPlan: vi.fn(),
  token: vi.fn(),
  pair: vi.fn(),
  list: vi.fn(),
  remove: vi.fn()
}));

vi.mock('../api', () => ({
  USERADMIN_URL_ROOT: '',
  billing: {
    getSubscribeInfo: mocks.info,
    switchPrimePlan: mocks.switchPlan
  }
}));

vi.mock('../api/backend', () => ({
  api: {
    devices: {
      pilotPair: mocks.pair,
      listDevices: mocks.list
    }
  }
}));

vi.mock('localforage', () => ({
  default: {
    getItem: mocks.token,
    removeItem: mocks.remove
  }
}));

vi.mock('../actions', () => ({
  analyticsEvent: () => ({
    type: 'analytics'
  }),
  updateDevices: devices => ({
    type: 'devices',
    devices
  }),
  refreshDevices: () => async dispatch => dispatch({
    type: 'devices',
    devices: await mocks.list()
  }),
  primeGetSubscription: () => ({
    type: 'subscription'
  }),
  updateRoute: vi.fn()
}));

vi.mock('../actions/files', () => ({
  FILE_NAMES: {
    qcameras: ['qcamera.ts']
  },
  fetchUploadUrls: mocks.urls,
  doUpload: mocks.upload,
  updateFiles: files => ({
    type: 'files',
    files
  }),
  setRouteViewed: vi.fn(),
  fetchFiles: vi.fn(),
  fetchAthenaQueue: vi.fn()
}));

vi.mock('../actions/cached', () => ({
  fetchEvents: vi.fn()
}));

vi.mock('./DriveMap', () => ({
  default: () => null
}));

vi.mock('./DriveVideo', () => ({
  default: () => null
}));

vi.mock('./DriveView/ClipMenu', () => ({
  default: () => null
}));

vi.mock('./Files/UploadQueue', () => ({
  default: () => null
}));

vi.mock('./DriveView', () => ({
  default: () => null
}));

vi.mock('./Dashboard', () => ({
  default: () => null
}));

vi.mock('./AppHeader', () => ({
  default: () => null
}));

vi.mock('./AppDrawer', () => ({
  default: () => null
}));

vi.mock('./BodyTeleop', () => ({
  default: () => null
}));

vi.mock('./Referrals', () => ({
  default: () => null
}));

vi.mock('./DriveView/NoDeviceUpsell', () => ({
  default: () => null
}));

vi.mock('./CommacareBadge', () => ({
  default: () => null,
  COMMACARE_URL: ''
}));

const A = 'aaaaaaaaaaaaaaaa';

const route = {
  fullname: `${A}|2026-08-06--12-00-00`,
  segment_numbers: [0],
  segment_start_times: [0],
  segment_end_times: [10000],
  start_time_utc_millis: 0
};

function harness() {
  let state = {
    sessionEpoch: 0,
    dongleId: A,
    entities: {
      routes: {
        [route.fullname]: route
      }
    },
    nav: {
      location: {
        base: {
          view: "drive",
          dongleId: A,
          drive: {
            logId: route.fullname.split("|")[1]
          }
        }
      }
    }
  };
  const services = createRoutingServices();
  const actions = [];
  const dispatch = (action) => {
    if (typeof action === 'function') return action(dispatch, () => state, services);
    actions.push(action);
    return action;
  };
  return {
    actions,
    dispatch,
    end: () => {
      state = {
        ...state,
        sessionEpoch: 1
      };
    }
  };
}

function component(Type, props) {
  const instance = new Type(props);
  instance.mounted = true;
  instance.setState = vi.fn(update => {
    instance.state = {
      ...instance.state,
      ...update
    };
  });
  return instance;
}

beforeEach(() => vi.clearAllMocks());
it.each(['uploadFile', 'uploadFilesAll'])('Media %s cannot submit signed URLs from an ended session', async method => {
  const h = harness();
  let resolve;
  mocks.urls.mockImplementation(() => new Promise(r => resolve = r));
  const media = component(Media, {
    dispatch: h.dispatch,
    dongleId: A,
    currentRoute: route,
    loop: {
      startTime: 0,
      duration: 10000
    },
    files: {}
  });
  const pending = method === 'uploadFile' ? media.uploadFile('qcameras') : media.uploadFilesAll(['qcameras']);
  h.end();
  resolve(['https://signed']);
  await pending;
  expect(mocks.upload).not.toHaveBeenCalled();
});
it.each(['logout', 'unmount'])('Prime cannot begin billing after a delayed prerequisite and %s', async boundary => {
  const h = harness();
  let resolve;
  mocks.info.mockImplementation(() => new Promise(r => resolve = r));
  const prime = component(PrimeManage, {
    dispatch: h.dispatch,
    dongleId: A,
    subscription: {
      plan: 'nodata'
    }
  });
  prime.state.planSwitchTarget = 'data';
  const pending = prime.switchPlan();
  if (boundary === 'logout') h.end();else prime.mounted = false;
  resolve({
    sim_id: 'sim'
  });
  await pending;
  expect(mocks.switchPlan).not.toHaveBeenCalled();
});
it.each(['logout', 'unmount'])('stored-token retrieval cannot begin pairing after %s', async boundary => {
  const h = harness();
  let resolve;
  mocks.token.mockImplementation(() => new Promise(r => resolve = r));
  const explorer = component(ExplorerApp, {
    dispatch: h.dispatch
  });
  const pending = explorer.pairFromStoredToken();
  await Promise.resolve();
  await Promise.resolve();
  if (boundary === 'logout') h.end();else explorer.mounted = false;
  resolve('stale-token');
  await pending;
  expect(mocks.pair).not.toHaveBeenCalled();
  expect(explorer.setState).not.toHaveBeenCalled();
});
it.each(['uploadFile', 'uploadFilesAll'])('Media %s handles missing signed grants without a mutation or stuck requested state', async method => {
  const h = harness();
  mocks.urls.mockResolvedValue(null);
  const media = component(Media, {
    dispatch: h.dispatch,
    dongleId: A,
    currentRoute: route,
    loop: {
      startTime: 0,
      duration: 10000
    },
    files: {}
  });
  await (method === 'uploadFile' ? media.uploadFile('qcameras') : media.uploadFilesAll(['qcameras']));
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(Object.values(h.actions.filter(a => a.type === 'files').at(-1).files)).toEqual([{}]);
});
