import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MyCommaAuth, { storage as AuthStorage } from '@commaai/my-comma-auth';

import { bootstrapSession } from './session';
import reducer from '../reducers/globalState';
import { createInitialState } from '../initialState';
import { createRoutingServices } from '../routing/services';

const mocks = vi.hoisted(() => ({ logout: vi.fn(), navigate: vi.fn() }));

vi.mock('../api/backend', () => ({
  api: {
    auth: { isAuthenticated: () => true, logOut: mocks.logout },
    account: {
      getProfile: async () => {
        const error = new Error('Unauthorized');
        error.resp = { status: 401 };
        throw error;
      },
    },
    devices: { listDevices: async () => [] },
  },
}));

vi.mock('../api', () => ({
  request: { configure: vi.fn() },
  athena: { configure: vi.fn() },
  billing: { configure: vi.fn() },
}));

vi.mock('../utils/webrtc', () => ({ webrtcConnectionManager: { disconnect: vi.fn() } }));

vi.mock('../utils/navigation', () => ({ hardNavigate: mocks.navigate }));

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createHarness() {
  let state = {
    ...createInitialState(),
    profile: { id: 'private' },
    router: { location: { pathname: '/public', search: '?ext=1', hash: '#keep' } },
  };
  const services = createRoutingServices();
  const getState = () => state;
  const dispatch = (action) => {
    if (typeof action === 'function') return action(dispatch, getState, services);
    state = reducer(state, action);
    return action;
  };

  return {
    dispatch,
    getState,
    services,
    replaceSession() {
      state = { ...state, sessionEpoch: state.sessionEpoch + 1, profile: { id: 'new' } };
    },
  };
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

it('does not redirect a replacement session after credential removal', async () => {
  const credentials = deferred();
  const logout = vi.spyOn(AuthStorage, 'logOut').mockReturnValue(credentials.promise);
  const sdkLogout = vi.spyOn(MyCommaAuth, 'logOut');
  mocks.logout.mockImplementation(() => MyCommaAuth.logOut());
  const harness = createHarness();

  const pending = harness.dispatch(bootstrapSession());
  await vi.waitFor(() => expect(logout).toHaveBeenCalled());
  expect(harness.getState().profile).toBeNull();
  expect(harness.getState().sessionEpoch).toBe(1);

  harness.replaceSession();
  credentials.resolve();
  await pending;

  expect(sdkLogout).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(harness.getState().profile).toEqual({ id: 'new' });
});

it('clears a rejected session before reloading its full URL', async () => {
  const credentials = deferred();
  const logout = vi.spyOn(AuthStorage, 'logOut').mockReturnValue(credentials.promise);
  const harness = createHarness();

  const pending = harness.dispatch(bootstrapSession());
  await vi.waitFor(() => expect(logout).toHaveBeenCalled());
  expect(harness.getState().profile).toBeNull();
  expect(harness.getState().sessionEpoch).toBe(1);
  expect(mocks.navigate).not.toHaveBeenCalled();

  credentials.resolve();
  await pending;

  expect(mocks.navigate).toHaveBeenCalledWith('/public?ext=1#keep');
  expect(mocks.logout).not.toHaveBeenCalled();
});

it('waits for persisted cache clearing before reloading', async () => {
  vi.spyOn(AuthStorage, 'logOut').mockResolvedValue();
  const purge = deferred();
  const clear = vi.fn(() => purge.promise);
  const harness = createHarness();
  harness.services.assetCache = { clear };

  const pending = harness.dispatch(bootstrapSession());
  await vi.waitFor(() => expect(clear).toHaveBeenCalled());
  expect(mocks.navigate).not.toHaveBeenCalled();

  purge.resolve();
  await pending;

  expect(mocks.navigate).toHaveBeenCalledWith('/public?ext=1#keep');
});
