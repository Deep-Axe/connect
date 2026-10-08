import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddDeviceDialog } from './Dashboard/AddDevice';
import { PrimeManage } from './Prime/PrimeManage';

const mocks = vi.hoisted(() => ({
  pair: vi.fn(),
  subscribeInfo: vi.fn(),
  switchPlan: vi.fn(),
  stripe: vi.fn()
}));

vi.mock('../api/backend', () => ({
  api: {
    devices: {
      pilotPair: mocks.pair
    }
  }
}));

vi.mock('../api', () => ({
  billing: {
    getSubscribeInfo: mocks.subscribeInfo,
    switchPrimePlan: mocks.switchPlan,
    getStripeSession: mocks.stripe
  }
}));

vi.mock('../actions', () => ({
  analyticsEvent: (name, parameters) => ({
    type: 'ANALYTICS',
    name,
    parameters
  }),
  refreshDevices: () => ({
    type: 'REFRESH_DEVICES'
  }),
  refreshSubscription: () => ({
    type: 'REFRESH_SUBSCRIPTION'
  }),
  leaveForExternalUrl: () => ({
    type: 'EXTERNAL'
  })
}));

vi.mock('barcode-detector/ponyfill', () => ({
  BarcodeDetector: class {}
}));

const A = 'aaaaaaaaaaaaaaaa',
  B = 'bbbbbbbbbbbbbbbb';

function localState(component) {
  component.setState = (next, callback) => {
    component.state = {
      ...component.state,
      ...(typeof next === 'function' ? next(component.state, component.props) : next)
    };
    callback?.();
  };
  return component;
}

function leaseDispatch(dongleId = A) {
  const state = {
    dongleId,
    sessionEpoch: 0,
    nav: {
      location: {}
    }
  };
  const dispatch = vi.fn(action => typeof action === 'function' ? action(dispatch, () => state) : action);
  dispatch.state = state;
  return dispatch;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pair.mockResolvedValue({
    dongle_id: A
  });
  mocks.switchPlan.mockResolvedValue({
    success: true
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('task ownership across asynchronous boundaries', () => {
  it('a QR result arriving after the dialog closes cannot initiate pairing', async () => {
    let resolveDetection;
    const dialog = localState(new AddDeviceDialog({
      dispatch: vi.fn(),
      devices: [],
      onClose: vi.fn()
    }));
    dialog.mounted = true;
    dialog.scanning = true;
    dialog.videoRef = {
      pause: vi.fn()
    };
    dialog.detector = {
      detect: () => new Promise(r => {
        resolveDetection = r;
      })
    };
    const pending = dialog.scanFrame();
    dialog.componentWillUnmount();
    const token = `${btoa('{}')}.${btoa(JSON.stringify({
      identity: A
    }))}.sig`;
    resolveDetection([{
      rawValue: `https://connect.comma.ai?pair=${token}`
    }]);
    await pending;
    await Promise.resolve();
    expect(mocks.pair).not.toHaveBeenCalled();
  });

  it('a Prime plan dialog moving between devices derives the new device target', () => {
    const props = {
      dongleId: A,
      subscription: {
        plan: 'data',
        user_id: 'user'
      },
      modal: 'change-plan',
      dispatch: vi.fn()
    };
    const prime = localState(new PrimeManage(props));
    prime.componentDidUpdate({}, {});
    expect(prime.state.planSwitchTarget).toBe('nodata');
    prime.props = {
      ...props,
      dongleId: B,
      subscription: {
        plan: 'nodata',
        user_id: 'user'
      }
    };
    prime.componentDidUpdate(props, {
      ...prime.state
    });
    expect(prime.state.planSwitchTarget).toBe('data');
  });

  it('a delayed plan prerequisite cannot start a mutation after its task unmounted', async () => {
    let resolveInfo;
    mocks.subscribeInfo.mockImplementation(() => new Promise(r => {
      resolveInfo = r;
    }));
    const prime = localState(new PrimeManage({
      dongleId: A,
      subscription: {
        plan: 'nodata'
      },
      dispatch: leaseDispatch()
    }));
    prime.mounted = true;
    prime.state.planSwitchTarget = 'data';
    const pending = prime.switchPlan();
    prime.componentWillUnmount();
    resolveInfo({
      sim_id: 'old-session-sim'
    });
    await pending;
    expect(mocks.switchPlan).not.toHaveBeenCalled();
  });

  it('changing only the modal invalidates a pending plan mutation', async () => {
    let resolveInfo;
    mocks.subscribeInfo.mockImplementation(() => new Promise(r => {
      resolveInfo = r;
    }));
    const dispatch = leaseDispatch();
    const prime = localState(new PrimeManage({
      dongleId: A,
      subscription: {
        plan: 'nodata'
      },
      dispatch
    }));
    prime.mounted = true;
    const pending = prime.switchPlan();
    dispatch.state.nav.location = {}; // a different modal on the same page
    resolveInfo({
      sim_id: 'sim'
    });
    await pending;
    expect(mocks.switchPlan).not.toHaveBeenCalled();
    prime.componentWillUnmount();
  });

  it('same-kind location navigation releases the old loading state', async () => {
    let resolveInfo;
    mocks.subscribeInfo.mockImplementation(() => new Promise(r => {
      resolveInfo = r;
    }));
    const dispatch = leaseDispatch();
    const props = {
      dongleId: A,
      subscription: {
        plan: 'nodata'
      },
      modal: 'change-plan',
      taskLocation: dispatch.state.nav.location,
      dispatch
    };
    const prime = localState(new PrimeManage(props));
    prime.mounted = true;
    const pending = prime.switchPlan();
    expect(prime.state.switchingPlan).toBe(true);
    dispatch.state.nav.location = {};
    prime.props = {
      ...props,
      taskLocation: dispatch.state.nav.location
    };
    prime.componentDidUpdate(props, {
      ...prime.state
    });
    expect(prime.state.switchingPlan).toBe(false);
    resolveInfo({
      sim_id: 'sim'
    });
    await pending;
    expect(mocks.switchPlan).not.toHaveBeenCalled();
    prime.componentWillUnmount();
  });

  it('a Stripe status response after unmount does not schedule a timer', async () => {
    vi.useFakeTimers();
    let resolveStatus;
    mocks.stripe.mockImplementation(() => new Promise(r => {
      resolveStatus = r;
    }));
    const prime = localState(new PrimeManage({
      dongleId: A,
      dispatch: leaseDispatch()
    }));
    prime.mounted = true;
    prime.state.stripeStatus = {
      sessionId: 'old-task',
      loading: true
    };
    const pending = prime.fetchStripeSession();
    prime.componentWillUnmount();
    resolveStatus({
      payment_status: 'unpaid'
    });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unmount clears an existing status poll timer', async () => {
    vi.useFakeTimers();
    mocks.stripe.mockResolvedValue({
      payment_status: 'unpaid'
    });
    const prime = localState(new PrimeManage({
      dongleId: A,
      dispatch: leaseDispatch()
    }));
    prime.mounted = true;
    prime.state.stripeStatus = {
      sessionId: 'active-task',
      loading: true
    };
    await prime.fetchStripeSession();
    expect(vi.getTimerCount()).toBe(1);
    prime.componentWillUnmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
