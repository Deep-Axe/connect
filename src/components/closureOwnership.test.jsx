import { beforeEach, expect, it, vi } from 'vitest';
import { createRoutingServices } from '../routing/services';
import { Media } from './DriveView/Media';
import { ExplorerApp } from './explorer';

const mocks = vi.hoisted(() => ({
  urls: vi.fn(),
  upload: vi.fn(),
  info: vi.fn(),
  switchPlan: vi.fn(),
  token: vi.fn(),
  pair: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  public: vi.fn(),
  preserve: vi.fn(),
  preserved: vi.fn(),
  routeUpdate: vi.fn(),
}));
vi.mock('../api', () => ({
  USERADMIN_URL_ROOT: '',
  billing: { getSubscribeInfo: mocks.info, switchPrimePlan: mocks.switchPlan },
}));
vi.mock('../api/clips', () => ({ deviceSupportsClips: vi.fn() }));
vi.mock('../api/backend', () => ({
  api: {
    routes: { setRoutePublic: mocks.public, setRoutePreserved: mocks.preserve, getPreservedRoutes: mocks.preserved },
    devices: { pilotPair: mocks.pair, listDevices: mocks.list },
  },
}));
vi.mock('localforage', () => ({ default: { getItem: mocks.token, removeItem: mocks.remove } }));
vi.mock('../actions', () => ({
  analyticsEvent: () => ({ type: 'analytics' }),
  updateDevices: (devices) => ({ type: 'devices', devices }),
  refreshDevices: () => async (dispatch) => dispatch({ type: 'devices', devices: await mocks.list() }),
  primeGetSubscription: () => ({ type: 'subscription' }),
  updateRoute: mocks.routeUpdate,
}));
vi.mock('../actions/files', () => ({
  FILE_NAMES: { qcameras: ['qcamera.ts'] },
  fetchUploadUrls: mocks.urls,
  doUpload: mocks.upload,
  updateFiles: (files) => ({ type: 'files', files }),
  setRouteViewed: vi.fn(),
  fetchFiles: vi.fn(),
  fetchAthenaQueue: vi.fn(),
}));
vi.mock('../actions/cached', () => ({ fetchEvents: vi.fn() }));
vi.mock('./DriveMap', () => ({ default: () => null }));
vi.mock('./DriveVideo', () => ({ default: () => null }));
vi.mock('./DriveView/ClipMenu', () => ({ default: () => null }));
vi.mock('./Files/UploadQueue', () => ({ default: () => null }));
vi.mock('./DriveView', () => ({ default: () => null }));
vi.mock('./Dashboard', () => ({ default: () => null }));
vi.mock('./AppHeader', () => ({ default: () => null }));
vi.mock('./AppDrawer', () => ({ default: () => null }));
vi.mock('./BodyTeleop', () => ({ default: () => null }));
vi.mock('./Referrals', () => ({ default: () => null }));
vi.mock('./DriveView/NoDeviceUpsell', () => ({ default: () => null }));
vi.mock('./CommacareBadge', () => ({ default: () => null, COMMACARE_URL: '' }));

const A = 'aaaaaaaaaaaaaaaa';
const route = {
  fullname: `${A}|2026-08-06--12-00-00`,
  segment_numbers: [0],
  segment_start_times: [0],
  segment_end_times: [10000],
  start_time_utc_millis: 0,
};
function harness() {
  let state = { sessionEpoch: 0, dongleId: A, currentRoute: route };
  const services = createRoutingServices();
  const actions = [];
  const dispatch = (action) =>
    typeof action === 'function' ? action(dispatch, () => state, services) : (actions.push(action), action);
  return {
    actions,
    dispatch,
    end: () => {
      state = { ...state, sessionEpoch: 1 };
    },
  };
}
function component(Type, props) {
  const instance = new Type(props);
  instance.mounted = true;
  instance.setState = vi.fn((update) => {
    instance.state = { ...instance.state, ...update };
  });
  return instance;
}
beforeEach(() => vi.clearAllMocks());

it('CLOSURE old public-flag response cannot update an ended session', async () => {
  const h = harness();
  let reply;
  mocks.public.mockImplementation(() => new Promise((r) => (reply = r)));
  const media = component(Media, { dispatch: h.dispatch, dongleId: A, currentRoute: route });
  const pending = media.onPublicToggle({ target: { checked: true } });
  h.end();
  reply({ fullname: route.fullname, is_public: true });
  await pending;
  expect(mocks.routeUpdate).not.toHaveBeenCalled();
});
it('CLOSURE old preserve response cannot update a different current route', async () => {
  const h = harness();
  let reply;
  mocks.preserve.mockImplementation(() => new Promise((r) => (reply = r)));
  const media = component(Media, { dispatch: h.dispatch, dongleId: A, currentRoute: route });
  const pending = media.onPreserveToggle({ target: { checked: true } });
  media.props = { ...media.props, currentRoute: { ...route, fullname: `${A}|2026-08-06--13-00-00` } };
  reply({ success: true });
  await pending;
  expect(media.setState).not.toHaveBeenCalled();
});
it('CLOSURE preserve refresh fallback cannot start new work after logout', async () => {
  const h = harness();
  let reply;
  mocks.preserve.mockImplementation(() => new Promise((r) => (reply = r)));
  mocks.preserved.mockResolvedValue([]);
  const media = component(Media, { dispatch: h.dispatch, dongleId: A, currentRoute: route });
  const pending = media.onPreserveToggle({ target: { checked: true } });
  h.end();
  reply({ success: false });
  await pending;
  expect(mocks.preserved).not.toHaveBeenCalled();
});
it('CLOSURE an old pairing completion cannot delete a newer stored token', async () => {
  const h = harness();
  const explorer = component(ExplorerApp, { dispatch: h.dispatch });
  let reply;
  const old = `e30.${btoa(JSON.stringify({ identity: A }))}.sig`;
  let stored = old;
  mocks.token.mockImplementation(async () => stored);
  mocks.remove.mockImplementation(async () => {
    stored = null;
  });
  mocks.pair.mockImplementation(() => new Promise((r) => (reply = r)));
  mocks.list.mockResolvedValue([]);
  const pending = explorer.pairFromStoredToken();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  stored = 'newer-token';
  reply({ dongle_id: A });
  await pending;
  expect(stored).toBe('newer-token');
});
it('CLOSURE pairing prerequisite logout guard remains closed', async () => {
  const h = harness();
  const explorer = component(ExplorerApp, { dispatch: h.dispatch });
  let reply;
  mocks.token.mockImplementation(() => new Promise((r) => (reply = r)));
  const pending = explorer.pairFromStoredToken();
  await Promise.resolve();
  await Promise.resolve();
  h.end();
  reply('old-token');
  await pending;
  expect(mocks.pair).not.toHaveBeenCalled();
});

it('the latest preserve attempt owns its local completion', async () => {
  const h = harness();
  const replies = [];
  mocks.preserve.mockImplementation(() => new Promise((r) => replies.push(r)));
  const media = component(Media, { dispatch: h.dispatch, dongleId: A, currentRoute: route });
  const old = media.onPreserveToggle({ target: { checked: true } });
  const fresh = media.onPreserveToggle({ target: { checked: false } });
  replies[1]({ success: true });
  await fresh;
  replies[0]({ success: true });
  await old;
  expect(media.state.routePreserved).toBe(false);
  expect(media.setState).toHaveBeenCalledTimes(1);
});
it('a preserve inventory response cannot write after unmount', async () => {
  const h = harness();
  let reply;
  mocks.preserved.mockImplementation(() => new Promise((r) => (reply = r)));
  const media = component(Media, { dispatch: h.dispatch, dongleId: A, currentRoute: route });
  const pending = media.fetchRoutePreserved();
  media.mounted = false;
  reply([{ fullname: route.fullname }]);
  await pending;
  expect(media.setState).not.toHaveBeenCalled();
});
