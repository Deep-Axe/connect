import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), captureException: vi.fn() }));

vi.mock('../api', () => ({ athena: { postJsonRpcPayload: mocks.rpc } }));
vi.mock('../api/backend', () => ({ api: { routes: {} } }));
vi.mock('@sentry/react', () => ({ captureException: mocks.captureException }));
vi.mock('./index', () => ({
  updateDeviceOnline: (dongleId, lastAthenaPing) => ({ type: 'online', dongleId, lastAthenaPing }),
  fetchDeviceNetworkStatus: vi.fn(),
  invalidateRoutes: vi.fn(),
}));

const DEVICE = 'aaaaaaaaaaaaaaaa';

function createHarness() {
  const state = {
    sessionEpoch: 0,
    dongleId: DEVICE,
    entities: { devices: { [DEVICE]: { dongle_id: DEVICE, openpilot_version: '0.9.9' } } },
  };
  const actions = [];
  const dispatch = (action) => {
    if (typeof action === 'function') return action(dispatch, () => state);
    actions.push(action);
    return action;
  };
  return { dispatch, actions };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('upload RPC errors', () => {
  it.each(['Timed out', 'Device not registered'])('marks %s as offline', async (message) => {
    const { cancelUploads } = await import('./files');
    const error = Object.assign(new Error(message), { resp: { status: 503 } });
    mocks.rpc.mockRejectedValue(error);
    const harness = createHarness();

    await harness.dispatch(cancelUploads(DEVICE, ['upload-1']));

    expect(harness.actions).toContainEqual(expect.objectContaining({
      type: 'online', dongleId: DEVICE, lastAthenaPing: 0,
    }));
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('reports an unrelated server failure without marking the device offline', async () => {
    const { cancelUploads } = await import('./files');
    const error = Object.assign(new Error('Internal server error'), { resp: { status: 500 } });
    mocks.rpc.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const harness = createHarness();

    await harness.dispatch(cancelUploads(DEVICE, ['upload-1']));

    expect(harness.actions).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(error);
    expect(mocks.captureException).toHaveBeenCalledWith(error, expect.anything());
  });
});

describe('upload RPC concurrency', () => {
  it('waits at the request limit and releases capacity after completion', async () => {
    vi.useFakeTimers();
    const { setRouteViewed } = await import('./files');
    const replies = [];
    mocks.rpc.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
    const harness = createHarness();

    const pending = Array.from({ length: 16 }, () => harness.dispatch(setRouteViewed(DEVICE, 'drive')));
    expect(mocks.rpc).toHaveBeenCalledTimes(15);

    replies.forEach((resolve) => resolve({ result: true }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.rpc).toHaveBeenCalledTimes(16);
    replies[15]({ result: true });
    await Promise.all(pending);

    mocks.rpc.mockResolvedValue({ result: true });
    await harness.dispatch(setRouteViewed(DEVICE, 'next-drive'));
    expect(mocks.rpc).toHaveBeenCalledTimes(17);
    expect(vi.getTimerCount()).toBe(0);
  });
});
