import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), captureException: vi.fn() }));

vi.mock('../api', () => ({ athena: { postJsonRpcPayload: mocks.rpc } }));
vi.mock('../api/backend', () => ({ api: {} }));
vi.mock('@sentry/react', () => ({ captureException: mocks.captureException }));

import * as Types from './types';
import { fetchDeviceNetworkStatus } from '.';

const DEVICE = 'aaaaaaaaaaaaaaaa';

function createHarness(openpilotVersion) {
  const state = {
    sessionEpoch: 0,
    dongleId: DEVICE,
    entities: {
      devices: { [DEVICE]: { dongle_id: DEVICE, openpilot_version: openpilotVersion } },
      deviceOrder: [DEVICE],
    },
  };
  const actions = [];
  const dispatch = (action) => {
    if (typeof action === 'function') return action(dispatch, () => state);
    actions.push(action);
    return action;
  };
  return { dispatch, actions };
}

const markedOffline = (actions) => actions.some((action) => (
  action.type === Types.ACTION_UPDATE_DEVICE_ONLINE && action.last_athena_ping === 0
));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// getNetworkMetered (0.8.14 and later) and getNetworkType (older)
describe.each(['0.9.9', '0.8.13'])('network status RPC errors (openpilot %s)', (version) => {
  it.each(['Timed out', 'Device not registered'])('marks "%s" as offline without reporting it', async (message) => {
    mocks.rpc.mockRejectedValue(new Error(message));
    const harness = createHarness(version);

    await harness.dispatch(fetchDeviceNetworkStatus(DEVICE));

    expect(markedOffline(harness.actions)).toBe(true);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('reports an unrelated failure without marking the device offline', async () => {
    const error = new Error('500: Internal server error');
    mocks.rpc.mockRejectedValue(error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness(version);

    await harness.dispatch(fetchDeviceNetworkStatus(DEVICE));

    expect(markedOffline(harness.actions)).toBe(false);
    expect(mocks.captureException).toHaveBeenCalledWith(error, expect.anything());
  });
});
