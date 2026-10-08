import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from 'history';

import App from './App';
import MyCommaAuth, {storage as AuthStorage} from '@commaai/my-comma-auth';
import { request as Request } from './api';
import { endSession } from './actions/session';
import { createInitialState } from './initialState';
import { selectSelectedRouteId } from './routing/selectors';
import { updateDevices } from './actions';
import { createAppStore } from './store';

const mocks = vi.hoisted(() => ({ authenticated: true, options: {}, requests: [], rpcs: [], hardNavigate: vi.fn() }));

vi.mock('@commaai/my-comma-auth', () => ({
  default: {
    init: vi.fn(async () => mocks.authenticated ? 'test-token' : null),
    isAuthenticated: vi.fn(() => mocks.authenticated),
    logOut: vi.fn(),
  },
  config: { AUTH_PATH: '/auth/' },
  storage: { setCommaAccessToken: vi.fn(), logOut: vi.fn() },
}));
vi.mock('./utils/navigation', () => ({ hardNavigate: mocks.hardNavigate }));
vi.mock('./utils/turn', () => ({ fetchTurnCredentials: vi.fn(async () => null) }));
vi.mock('./utils/webrtc', () => ({
  webrtcConnectionManager: {
    acquire: vi.fn(() => ({ setQuality: vi.fn(), switchCamera: vi.fn() })),
    connection: null,
    deviceChanged: vi.fn(),
    disconnect: vi.fn(),
    enterStream: vi.fn(),
    leaveStream: vi.fn(),
    prewarm: vi.fn(),
    reconnect: vi.fn(),
    release: vi.fn(),
  },
}));
vi.mock('react-map-gl', () => ({
  default: React.forwardRef((_props, ref) => <div ref={ref} data-testid="map" />),
  GeolocateControl: () => null,
  HTMLOverlay: () => null,
  Layer: () => null,
  LinearInterpolator: class {},
  Marker: ({ children }) => children,
  Source: ({ children }) => children,
  WebMercatorViewport: class {},
}));
vi.mock('react-player/file', () => ({
  default: React.forwardRef((_props, ref) => {
    React.useImperativeHandle(ref, () => ({
      getCurrentTime: () => 0,
      getDuration: () => 60,
      getInternalPlayer: () => ({
        buffered: { end: () => 60, length: 1, start: () => 0 },
        pause: vi.fn(), paused: true, play: vi.fn(async () => undefined), playbackRate: 1, readyState: 4,
      }),
      seekTo: vi.fn(),
    }));
    return <div data-testid="video-player" />;
  }),
}));
// jsdom has no IndexedDB: an in-memory store for the pair token and clip cache
vi.mock('localforage', () => {
  const store = () => {
    const items = new Map();
    return {
      getItem: async (key) => (items.has(key) ? items.get(key) : null),
      setItem: async (key, value) => { items.set(key, value); return value; },
      removeItem: async (key) => { items.delete(key); },
      keys: async () => [...items.keys()],
    };
  };
  return { default: { ...store(), createInstance: store } };
});
vi.mock('barcode-detector/ponyfill', () => ({ BarcodeDetector: class { detect() { return []; } } }));

const FIRST = 'aaaaaaaaaaaaaaaa';
const SECOND = 'bbbbbbbbbbbbbbbb';
const SHARED = 'cccccccccccccccc';
const LOG = '2026-08-06--12-00-00';
const RECENT_LOG = '2026-08-06--13-00-00';
const START = Date.UTC(2026, 7, 6, 12);

const devices = [
  { alias: 'Zulu', dongle_id: FIRST, device_type: 'threex', is_owner: true, prime: false },
  { alias: 'Alpha', dongle_id: SECOND, device_type: 'threex', is_owner: true, prime: false },
];

function makeRoute(dongleId, logId = RECENT_LOG) {
  const start = logId === LOG ? START : START + 3_600_000;
  return {
    create_time: start, distance: 1, dongle_id: dongleId, end_time_utc_millis: start + 60_000,
    events: [], fullname: `${dongleId}|${logId}`, maxqlog: 0,
    segment_end_times: [start + 60_000], segment_numbers: [0], segment_start_times: [start],
    startLocation: { place: logId === LOG ? 'Mock route start' : 'Mock recent route start', details: 'Start details' },
    endLocation: { place: 'Mock route end', details: 'End details' }, start_time_utc_millis: start,
    url: 'https://routes.example.com',
  };
}

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

async function mockFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  mocks.requests.push({ method: init.method || 'GET', url: url.href });
  if (url.hostname === 'athena.comma.ai') {
    const rpc = init.body ? JSON.parse(init.body) : {};
    mocks.rpcs.push(rpc.method);
    if (rpc.method === 'getClipState') return json({ jsonrpc: '2.0', id: rpc.id, result: { clips: mocks.options.clips ?? [] } });
    if (rpc.method === 'getVersion') return json({ jsonrpc: '2.0', id: rpc.id, result: { commit_date: 1 } });
    if (rpc.method === 'listUploadQueue') return json({ jsonrpc: '2.0', id: rpc.id, result: mocks.options.uploadQueue ?? [] });
    return json({ jsonrpc: '2.0', id: rpc.id ?? 0, result: {} });
  }
  const options = mocks.options;
  const deviceList = options.devices ?? devices;
  if (url.pathname === '/v1/me/turn') return json(null);
  if (url.pathname === '/v1/me/') return json({ id: 'test-user', superuser: false });
  if (url.pathname === '/v1/me/devices/') return json(deviceList);
  if (url.pathname === '/v1/referrals') return json(options.referrals ?? {
    code: 'ABC1234',
    cash: { available: 50, claimed: 50, pending: 50 },
    referrals: [
      { ordered_at: 1_777_000_000, status: 'available' },
      { ordered_at: 1_778_000_000, status: 'pending' },
      { ordered_at: 1_779_000_000, status: 'claimed' },
    ],
  });
  const segments = url.pathname.match(/^\/v1\/devices\/([a-f0-9]{16})\/routes_segments$/);
  if (segments) {
    const dongleId = segments[1];
    if (options.failedRoutes && url.searchParams.has('start')) return json({}, 500);
    if (options.emptyRoutes) return json([]);
    const routeStr = url.searchParams.get('route_str');
    if (routeStr) return json([LOG, RECENT_LOG].some((log) => routeStr.endsWith(`|${log}`)) ? [makeRoute(dongleId, routeStr.split('|')[1])] : []);
    if (window.location.pathname.includes(`/${START}/`) || url.searchParams.get('start') === String(START)) return json([makeRoute(dongleId, LOG)]);
    return json([makeRoute(dongleId)]);
  }
  if (url.pathname.endsWith('/location')) return json({ error: 'no_segments_uploaded' });
  if (url.pathname.endsWith('/stats')) return json(null);
  if (/^\/v1\.1\/devices\/[a-f0-9]{16}\/$/.test(url.pathname)) {
    const dongleId = url.pathname.split('/')[3];
    const listed = deviceList.find((device) => device.dongle_id === dongleId);
    if (listed) return json(listed);
    return json({ alias: 'Shared device', dongle_id: dongleId, device_type: 'threex', is_owner: false, prime: false });
  }
  if (url.pathname.endsWith('/prime/cancel')) return json({ success: true });
  if (url.pathname.endsWith('/subscription')) return json(options.subscription ?? null);
  if (url.pathname.endsWith('/subscribe_info')) return json(null);
  if (url.pathname.endsWith('/events.json') || url.pathname.endsWith('/coords.json')) return json([]);
  if (url.pathname.endsWith('/files') || url.pathname.endsWith('/preserved')) return json(url.pathname.endsWith('/files') ? {} : []);
  throw new Error(`Unhandled request: ${init.method || 'GET'} ${url.href}`);
}

async function renderApp(pathname, options = {}) {
  mocks.authenticated = options.authenticated !== false;
  mocks.options = options;
  mocks.requests = [];
  mocks.rpcs = [];
  window.history.replaceState({}, '', pathname);
  if (options.selected) localStorage.setItem('selectedDongleId', options.selected);
  const history = createMemoryHistory({ initialEntries: [pathname] });
  const store = createAppStore(history, createInitialState());
  const view = render(<App history={history} store={store} />);
  await waitFor(
    () => expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument(),
    { timeout: 5000 },
  );
  // Explorer initialization starts several independent async updates (device
  // details, stats, routes, and clip support). Let their promise chains finish
  // while React is inside act before handing control back to each test.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { ...view, history, store };
}

describe('whole-app behavior', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn(mockFetch));
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
    Object.defineProperty(window, 'scrollTo', { value: vi.fn(), configurable: true });
    Object.defineProperty(window, 'visualViewport', { value: { height: 800 }, configurable: true });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: vi.fn(() => null) });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ bottom: 100, height: 100, left: 0, right: 1000, top: 0, width: 1000, x: 0, y: 0 }),
    });
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mocks.hardNavigate.mockClear();
  });

  test('root uses a valid stored device and keeps the selection', async () => {
    const app = await renderApp('/', { selected: FIRST });
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    expect(app.history.location.pathname).toBe(`/${FIRST}`);
    expect(localStorage.getItem('selectedDongleId')).toBe(FIRST);
  });

  test('fetches the initial routes with a nonzero limit', async () => {
    await renderApp('/', { selected: FIRST });
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    const request = mocks.requests.find(({ url }) => url.includes('routes_segments'));
    expect(new URL(request.url).searchParams.get('limit')).toBe('5');
  });

  test.each([['no stored device', undefined], ['an unknown stored device', 'dddddddddddddddd']])('root selects first device with %s', async (_name, selected) => {
    const { history } = await renderApp('/', { selected });
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    expect(history.location.pathname).toBe(`/${SECOND}`);
    expect(localStorage.getItem('selectedDongleId')).toBe(SECOND);
  });

  test('root with no devices shows pairing', async () => {
    const { history } = await renderApp('/', { devices: [] });
    expect(await screen.findByRole('heading', { name: 'Pair your device' })).toBeVisible();
    expect(history.location.pathname).toBe('/');
  });

  test('referrals URL opens the referrals page', async () => {
    await renderApp('/referrals');
    expect(await screen.findByRole('heading', { name: /Refer a friend/ })).toBeVisible();
    expect((await screen.findAllByText('$50', { selector: 'dd' }))).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'claim rewards ($50)' })).toHaveAttribute(
      'href', expect.stringContaining('Referral%20coupon%3A%20ABC1234'),
    );
    expect(mocks.requests).toContainEqual({ method: 'GET', url: 'https://billing.comma.ai/v1/referrals' });
  });

  test.each([['owned', FIRST], ['shared', SHARED]])('direct entry opens %s device dashboard', async (_name, dongleId) => {
    const { history } = await renderApp(`/${dongleId}`);
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    expect(history.location.pathname).toBe(`/${dongleId}`);
  });

  test('dashboard filter and empty route states remain usable', async () => {
    await renderApp(`/${FIRST}`, { emptyRoutes: true });
    expect(await screen.findByText('No routes found in selected time range.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.requests.some(({ url }) => url.includes('routes_segments'))).toBe(true);
  });

  test.each([
    ['authenticated whole drive', `/${FIRST}/${LOG}`, true],
    ['authenticated ranged drive', `/${FIRST}/${LOG}/10/20`, true],
    ['public whole drive', `/${FIRST}/${LOG}`, false],
    ['public ranged drive', `/${FIRST}/${LOG}/10/20`, false],
  ])('%s opens from a cold entry', async (_name, pathname, authenticated) => {
    const { history, store } = await renderApp(pathname, { authenticated });
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
    expect(history.location.pathname).toBe(pathname);
    const ranged = pathname.endsWith('/10/20');
    expect(selectSelectedRouteId(store.getState())).toBe(LOG);
    expect(store.getState()).toMatchObject({
      zoom: { start: ranged ? 10000 : 0, end: ranged ? 20000 : 60000 },
      loop: { startTime: ranged ? 10000 : 0, duration: ranged ? 10000 : 60000 },
    });
  });

  test.each([
    ['private device', `/${FIRST}`], ['Prime', `/${FIRST}/prime`], ['stream', `/${FIRST}/stream`],
  ])('signed-out %s entry retains its path', async (_name, pathname) => {
    const { history } = await renderApp(pathname, { authenticated: false });
    expect(await screen.findByText('Sign in with Google')).toBeVisible();
    expect(history.location.pathname).toBe(pathname);
  });

  test('a missing public route redirects to login with the requested route', async () => {
    const pathname = `/${FIRST}/2026-08-06--99-99-99`;
    await renderApp(pathname, { authenticated: false });
    await waitFor(() => expect(mocks.hardNavigate).toHaveBeenCalledWith(`/?r=${encodeURIComponent(pathname)}`));
  });

  test('legacy timestamp URL converts after a successful lookup', async () => {
    const { history } = await renderApp(`/${FIRST}/${START}/${START + 60_000}`);
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}/${LOG}`));
  });

  test.each([['empty', { emptyRoutes: true }], ['failed', { failedRoutes: true }]])('legacy timestamp remains after an %s lookup', async (_name, options) => {
    const pathname = `/${FIRST}/${START}/${START + 60_000}`;
    const { history } = await renderApp(pathname, options);
    await waitFor(() => expect(history.location.pathname).toBe(pathname));
  });

  test('Prime close and browser history restore its view', async () => {
    const { history } = await renderApp(`/${FIRST}/prime`);
    expect(await screen.findByRole('heading', { name: 'comma prime' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}`));
    act(() => history.goBack());
    expect(await screen.findByRole('heading', { name: 'comma prime' })).toBeVisible();
  });

  test('stream close and browser history restore its view', async () => {
    const online = devices.map((device) => ({ ...device, commacare: true, last_athena_ping: Math.floor(Date.now() / 1000), openpilot_version: '0.11.2' }));
    const { history } = await renderApp(`/${FIRST}/stream`, { devices: online });
    expect(await screen.findByRole('button', { name: 'Close teleop' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close teleop' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}`));
    act(() => history.goBack());
    expect(await screen.findByRole('button', { name: 'Close teleop' })).toBeVisible();
  });

  test('device browser history restores exact dashboards', async () => {
    const { history } = await renderApp(`/${FIRST}`);
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    act(() => history.push(`/${SECOND}`));
    await waitFor(() => expect(history.location.pathname).toBe(`/${SECOND}`));
    act(() => history.goBack());
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}`));
    act(() => history.goForward());
    await waitFor(() => expect(history.location.pathname).toBe(`/${SECOND}`));
  });

  test('drive selection, timeline range, back, and close preserve exact URLs', async () => {
    const { history } = await renderApp(`/${FIRST}`, { selected: FIRST });
    fireEvent.click(await screen.findByText('Mock recent route start'));
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}/${RECENT_LOG}`));
    const timeline = await screen.findByRole('slider', { name: 'Drive timeline' });
    fireEvent.pointerDown(timeline, { button: 0, clientX: 200, pageX: 200 });
    fireEvent.pointerMove(document, { clientX: 700, pageX: 700 });
    fireEvent.pointerUp(document, { button: 0, clientX: 700, pageX: 700 });
    await waitFor(() => expect(history.location.pathname).toMatch(new RegExp(`/${FIRST}/${RECENT_LOG}/\\d+/\\d+$`)));
    act(() => history.goBack());
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}/${RECENT_LOG}`));
    fireEvent.click(within(document.body).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}`));
  });
  test('AUDIT anonymous landing -> public drive selects public view without remounting App', async () => {
    const app=await renderApp('/', {authenticated:false});
    expect(screen.getByText('Sign in with Google')).toBeVisible();
    await act(async()=>{app.history.push(`/${FIRST}/${LOG}/0/20`);await new Promise(r=>setTimeout(r,10));});
    expect(screen.queryByText('Sign in with Google')).not.toBeInTheDocument();
    expect(await screen.findByRole('slider',{name:'Drive timeline'})).toBeVisible();
  });
  test('AUDIT public drive -> dashboard selects login view without remounting App', async () => {
    const app=await renderApp(`/${FIRST}/${LOG}/0/20`, {authenticated:false});
    expect(await screen.findByRole('slider',{name:'Drive timeline'})).toBeVisible();
    await act(async()=>{app.history.push(`/${FIRST}`);await new Promise(r=>setTimeout(r,10));});
    expect(screen.getByText('Sign in with Google')).toBeVisible();
  });
  test('AUDIT query-only login return change updates stored full return location', async () => {
    const first=`/${FIRST}/${LOG}/0/20?x=one#first`;
    const second=`/${SECOND}/${LOG}/1/10?x=two#second`;
    const app=await renderApp(`/?r=${encodeURIComponent(first)}`,{authenticated:false});
    expect(sessionStorage.getItem('redirectURL')).toBe(first);
    await act(async()=>{app.history.push(`/?r=${encodeURIComponent(second)}`);await new Promise(r=>setTimeout(r,10));});
    expect(sessionStorage.getItem('redirectURL')).toBe(second);
  });
  describe('task dialogs by URL', () => {
    const online = () => devices.map((device) => ({
      ...device, last_athena_ping: Math.floor(Date.now() / 1000), openpilot_version: '0.11.2',
    }));
    const url = (history) => `${history.location.pathname}${history.location.search}`;
    let innerWidth;
    beforeEach(() => { innerWidth = window.innerWidth; });
    afterEach(() => { window.innerWidth = innerWidth; });

    test('settings for another device open over a drive and close back to it', async () => {
      window.innerWidth = 1400; // permanent drawer with the device list
      const { history, store } = await renderApp(`/${FIRST}/${LOG}/10/20`);
      await screen.findByRole('slider', { name: 'Drive timeline' });
      const player = screen.getByTestId('video-player');
      const { zoom } = store.getState();
      const gear = screen.getAllByRole('button', { name: 'device settings' })
        .find((button) => button.closest('a').getAttribute('href') === `/${SECOND}`);
      fireEvent.click(gear);
      await waitFor(() => expect(url(history)).toBe(`/${FIRST}/${LOG}/10/20?modal=settings&modalDevice=${SECOND}`));
      expect(await screen.findByText('Device settings')).toBeVisible();
      expect(screen.getByDisplayValue('Alpha')).toBeInTheDocument();
      expect(screen.getByTestId('video-player')).toBe(player);
      expect(store.getState().zoom).toBe(zoom);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(url(history)).toBe(`/${FIRST}/${LOG}/10/20`));
      expect(screen.getByTestId('video-player')).toBe(player);
    });

    test('a settings link opens without the drawer and closes to the dashboard', async () => {
      window.innerWidth = 800;
      const { history } = await renderApp(`/${FIRST}/settings`);
      expect(await screen.findByText('Device settings')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(url(history)).toBe(`/${FIRST}`));
      expect(history.length).toBe(1);
    });

    test('the uploads link opens the queue over settings', async () => {
      const { history } = await renderApp(`/${FIRST}/settings/uploads`, { devices: online() });
      expect(await screen.findByText('Upload queue')).toBeVisible();
      expect(await screen.findByText('no uploads')).toBeVisible(); // the queue actually loaded
      expect(screen.getByText('Device settings')).toBeInTheDocument();
      act(() => { history.goBack(); }); // nothing to go back to in a fresh session: stays
      expect(url(history)).toBe(`/${FIRST}/settings/uploads`);
    });

    test("settings for a device the account doesn't own are not shown", async () => {
      await renderApp(`/${SHARED}/settings`);
      expect(await screen.findByText("You don't have access to this device's settings.")).toBeVisible();
    });

    test('the add-device link does not start the camera until asked', async () => {
      const getUserMedia = vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { enumerateDevices: vi.fn(async () => [{ kind: 'videoinput' }]), getUserMedia },
      });
      const { history } = await renderApp('/devices/add', { selected: FIRST });
      await waitFor(() => expect(url(history)).toBe(`/${FIRST}?modal=add-device`));
      expect(await screen.findByText('Pair device')).toBeVisible();
      const start = await screen.findByRole('button', { name: 'scan QR code with camera' });
      expect(getUserMedia).not.toHaveBeenCalled();
      fireEvent.click(start);
      await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
      expect(await screen.findByText(/Camera access denied/)).toBeVisible();
    });

    test('opening add-device with its button starts the camera without asking again', async () => {
      window.innerWidth = 1400; // the device list (with its add button) is in the permanent drawer
      const getUserMedia = vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { enumerateDevices: vi.fn(async () => [{ kind: 'videoinput' }]), getUserMedia },
      });
      const { history } = await renderApp(`/${FIRST}`);
      fireEvent.click(await screen.findByRole('button', { name: 'add new device' }));
      await waitFor(() => expect(url(history)).toBe(`/${FIRST}?modal=add-device`));
      await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: 'scan QR code with camera' })).not.toBeInTheDocument();
    });

    test('a clip preview link for a changed clip says so instead of showing another version', async () => {
      const clips = [{ filename: 'trip.mp4', requested_at: 222, status: 'ready', camera: 'fcamera.hevc', source_start_time: 0, source_end_time: 10, route: 'x' }];
      await renderApp(`/${FIRST}/clips?clip=trip.mp4&clipRequestedAt=111`, { devices: online(), clips });
      expect(await screen.findByText('This clip changed on the device since the link was made.')).toBeVisible();
      expect(mocks.rpcs).not.toContain('getClipChunk');
    });

    test('a filename-only clip link resolves to the current version', async () => {
      const clips = [{ filename: 'trip.mp4', requested_at: 222, status: 'ready', camera: 'fcamera.hevc', source_start_time: 0, source_end_time: 10, route: 'x' }];
      const { history } = await renderApp(`/${FIRST}/clips?clip=trip.mp4`, { devices: online(), clips });
      await waitFor(() => expect(history.location.search).toBe('?clip=trip.mp4&clipRequestedAt=222'));
      expect(history.length).toBe(1);
      expect(mocks.rpcs).not.toContain('createClip');
      expect(mocks.rpcs).not.toContain('deleteClip');
    });

    test('a Prime cancel link for a device without Prime explains why, and submits nothing', async () => {
      const { history } = await renderApp(`/${FIRST}/prime/cancel`);
      expect(await screen.findByText('This device has no comma prime subscription.')).toBeVisible();
      expect(mocks.requests.some(({ url: u }) => u.includes('/prime/cancel'))).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(url(history)).toBe(`/${FIRST}/prime`));
    });

    test('cancelling Prime from its link, then losing the subscription, just closes the dialog', async () => {
      const primeDevices = devices.map((device) => ({ ...device, prime: true, prime_type: 2 }));
      const subscription = {
        user_id: 'test-user', plan: 'data', amount: 2400, is_prime_sim: false, trial_end: null,
        next_charge_at: 1_900_000_000, subscribed_at: 1_700_000_000, cancel_at: null, requires_migration: false,
      };
      const { history, store } = await renderApp(`/${FIRST}/prime/cancel`, { devices: primeDevices, subscription });
      expect(await screen.findByText('Cancel prime subscription')).toBeVisible();
      expect(mocks.requests.some(({ method, url: u }) => method === 'POST' && u.includes('/prime/cancel'))).toBe(false);
      fireEvent.click(document.querySelector('.primeModalCancel'));
      await waitFor(() => expect(mocks.requests.some(({ method, url: u }) => method === 'POST' && u.includes('/prime/cancel'))).toBe(true));
      // the device list refreshes and the device is no longer on Prime
      act(() => { store.dispatch(updateDevices(devices)); });
      await waitFor(() => expect(url(history)).toBe(`/${FIRST}/prime`));
      expect(screen.queryByText('This device has no comma prime subscription.')).not.toBeInTheDocument();
    });

    test('an unrelated dialog over an unsubscribed Prime page is not treated as a Prime dialog', async () => {
      await renderApp(`/${FIRST}/prime?modal=add-device`);
      expect(await screen.findByText('Pair device')).toBeVisible();
      expect(screen.queryByText('This device has no comma prime subscription.')).not.toBeInTheDocument();
    });

    test('a preview link for a clip still being made opens once the clip is ready', async () => {
      const clip = { filename: 'trip.mp4', requested_at: 222, status: 'encoding', camera: 'fcamera.hevc', source_start_time: 0, source_end_time: 10, route: 'x' };
      mocks.options = { clips: [clip] };
      const { history } = await renderApp(`/${FIRST}/clips?clip=trip.mp4&clipRequestedAt=222`, { devices: online(), clips: [clip] });
      expect(await screen.findByText('This clip is still being made.')).toBeVisible();
      mocks.options.clips = [{ ...clip, status: 'ready' }]; // the next poll sees it finished
      await waitFor(() => expect(mocks.rpcs).toContain('getClipChunk'), { timeout: 4000 });
      expect(history.location.search).toBe('?clip=trip.mp4&clipRequestedAt=222');
    });

    test.each(['close', 'Back'])('pairing camera stops once on %s', async (exit) => {
      const stop = vi.fn();
      const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { enumerateDevices: vi.fn(async () => [{ kind: 'videoinput' }]), getUserMedia },
      });
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      try {
        const { history } = await renderApp(`/${FIRST}`);
        act(() => { history.push(`/${FIRST}?modal=add-device`); });
        fireEvent.click(await screen.findByRole('button', { name: 'scan QR code with camera' }));
        await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(play).toHaveBeenCalled());
        if (exit === 'Back') {
          act(() => { history.goBack(); });
        } else {
          fireEvent.click(document.querySelector('[class*="MuiBackdrop"]'));
        }
        await waitFor(() => expect(history.location.search).toBe(''));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalled();
      } finally {
        play.mockRestore();
      }
    });

    test('a camera that arrives after the dialog closed is stopped', async () => {
      let grant;
      const stop = vi.fn();
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          enumerateDevices: vi.fn(async () => [{ kind: 'videoinput' }]),
          getUserMedia: vi.fn(() => new Promise((resolve) => { grant = resolve; })),
        },
      });
      const { history } = await renderApp(`/${FIRST}?modal=add-device`);
      fireEvent.click(await screen.findByRole('button', { name: 'scan QR code with camera' }));
      await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
      act(() => { history.push(`/${FIRST}`); }); // closed while permission is pending
      await waitFor(() => expect(screen.queryByText('Pair device')).not.toBeInTheDocument());
      await act(async () => { grant({ getTracks: () => [{ stop }] }); });
      expect(stop).toHaveBeenCalled();
    });

    test('a dialog over a page that cannot take one is an invalid link', async () => {
      await renderApp(`/${FIRST}/stream?modal=settings`);
      expect(await screen.findByText('Page not found')).toBeVisible();
    });
  });
  test('adversarial Prime device transition uses the destination plan', async () => {
    const primeDevices = devices.map((device) => ({ ...device, prime: true, prime_type: 2 }));
    const subscription = {
      user_id: 'test-user', plan: 'data', amount: 2400, is_prime_sim: false, trial_end: null,
      next_charge_at: 1_900_000_000, subscribed_at: 1_700_000_000, cancel_at: null, requires_migration: false,
    };
    const { history } = await renderApp(`/${FIRST}/prime/change-plan`, { devices: primeDevices, subscription });
    expect(await screen.findByRole('heading', { name: 'Switch to Lite plan' })).toBeVisible();
    mocks.options.subscription = { ...subscription, plan: 'nodata', amount: 1400 };
    act(() => { history.push(`/${SECOND}/prime/change-plan`); });
    await waitFor(() => expect(mocks.requests.some(({ url: u }) => u.includes('/subscription') && new URL(u).searchParams.get('dongle_id') === SECOND)).toBe(true));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('heading', { name: 'Switch to Standard plan' })).toBeVisible();
  });


});

test('an authorized 401 clears private ownership and reloads the complete public URL', async()=>{
 const history=createMemoryHistory({initialEntries:[`/${FIRST}/${LOG}?ext=kept#bookmark`]});
 const store=createAppStore(history,createInitialState());
 const app=new App({store,history});
 await app.apiErrorResponseCallback({status:401});
 expect(store.getState().sessionEpoch).toBe(1);
 expect(mocks.hardNavigate).toHaveBeenCalledWith(`/${FIRST}/${LOG}?ext=kept#bookmark`);
});

test('delayed startup auth cannot configure an ended session',async()=>{
 const history=createMemoryHistory({initialEntries:[`/${FIRST}/stream`]});
 const store=createAppStore(history,createInitialState());const app=new App({store,history});
 app.setState=vi.fn();let resolve;
 MyCommaAuth.init.mockImplementationOnce(()=>new Promise(r=>resolve=r));
 const pending=app.componentDidMount();store.dispatch(endSession());resolve('old-token');await pending;
 expect(Request.headers.Authorization).toBeUndefined();expect(app.setState).not.toHaveBeenCalled();
});
test('delayed 401 logout cannot reload a successor session',async()=>{
 const history=createMemoryHistory({initialEntries:[`/${FIRST}/${LOG}`]});
 const store=createAppStore(history,createInitialState());const app=new App({store,history});let resolve;
 AuthStorage.logOut.mockImplementationOnce(()=>new Promise(r=>resolve=r));mocks.hardNavigate.mockClear();
 const pending=app.apiErrorResponseCallback({status:401});store.dispatch(endSession());resolve();await pending;
 expect(mocks.hardNavigate).not.toHaveBeenCalled();
});
