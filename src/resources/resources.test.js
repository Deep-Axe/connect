import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ files: vi.fn(), subscription: vi.fn(), info: vi.fn() }));
vi.mock('../api/backend', () => ({ api: { routes: { getRouteFiles: mocks.files } } }));
vi.mock('../api', () => ({ request: { configure: vi.fn() }, athena: { configure: vi.fn() }, billing: { configure: vi.fn(), getSubscription: mocks.subscription, getSubscribeInfo: mocks.info } }));

import { createInitialState } from '../initialState';
import globalState from '../reducers/globalState';
import { createRoutingServices } from '../routing/services';
import { fetchFiles, invalidateFiles } from '../actions/files';
import { primeFetchSubscription, refreshSubscription } from '../actions';
import { endSession } from '../actions/session';
import { selectFiles, selectSubscription } from './selectors';
import { fileInventoryExpiry, SIGNED_URL_MARGIN_MS } from './freshness';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';
const FULL = `${A}|${LOG}`;
const NOW = Date.UTC(2026, 9, 8, 12);
const signed = (dongleId, expires, suffix = '') => `https://files/${dongleId}/${LOG}/0/qcamera.ts?se=${encodeURIComponent(new Date(expires).toISOString())}&sig=${suffix}`;

function harness() {
  let state = createInitialState();
  state.entities.devices = { [A]: { dongle_id: A, is_owner: true, prime: true }, [B]: { dongle_id: B, is_owner: true, prime: true } };
  state.entities.deviceOrder = [A, B];
  const services = createRoutingServices();
  const dispatch = (action) => typeof action === 'function'
    ? action(dispatch, () => state, services)
    : (state = globalState(state, action), action);
  const select = (dongleId) => {
    state = { ...state, dongleId, nav: { ...state.nav, location: { base: { view: 'drive', dongleId, drive: { logId: LOG } } } } };
  };
  select(A);
  return { dispatch, getState: () => state, setState: value => { state = value; }, services, select };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  Object.values(mocks).forEach((mock) => mock.mockReset());
});
afterEach(() => { vi.useRealTimers(); });

describe('keyed subscription and file queries', () => {
  it('retains subscriptions across A→B→A and refreshes after 60 seconds', async () => {
    mocks.subscription.mockImplementation(async (id) => ({ user_id: 'u', device: id }));
    const h = harness();
    await h.dispatch(primeFetchSubscription(A)); h.select(B);
    await h.dispatch(primeFetchSubscription(B)); h.select(A);
    await h.dispatch(primeFetchSubscription(A));
    expect(mocks.subscription).toHaveBeenCalledTimes(2);
    expect(selectSubscription(h.getState()).device).toBe(A);
    vi.setSystemTime(NOW + 60_000);
    await h.dispatch(primeFetchSubscription(A));
    expect(mocks.subscription).toHaveBeenCalledTimes(3);
  });

  it('deduplicates exact queries and prevents a forced subscription refresh being overwritten', async () => {
    const answers = [];
    mocks.subscription.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const h = harness();
    const old = h.dispatch(primeFetchSubscription(A));
    const shared = h.dispatch(primeFetchSubscription(A));
    await Promise.resolve();
    expect(mocks.subscription).toHaveBeenCalledTimes(1);
    const fresh = h.dispatch(refreshSubscription(A)); await Promise.resolve();
    answers[1]({ user_id: 'u', plan: 'fresh' }); await fresh;
    answers[0]({ user_id: 'u', plan: 'old' }); await old; await shared;
    expect(selectSubscription(h.getState()).plan).toBe('fresh');
  });

  it('retains inactive file inventories and stable references through a range/modal change', async () => {
    mocks.files.mockImplementation(async (fullname) => ({ qcameras: [signed(fullname.split('|')[0], NOW + 3_600_000)] }));
    const h = harness();
    await h.dispatch(fetchFiles(FULL)); const first = selectFiles(h.getState());
    await h.dispatch(fetchFiles(FULL));
    expect(selectFiles(h.getState())).toBe(first);
    h.select(B); await h.dispatch(fetchFiles(`${B}|${LOG}`)); h.select(A);
    await h.dispatch(fetchFiles(FULL));
    expect(mocks.files).toHaveBeenCalledTimes(2);
    expect(selectFiles(h.getState())[`${FULL}--0/qcameras`].url).toContain(`/${A}/`);
  });

  it('expires at the earliest exact SAS expiry minus five minutes', async () => {
    const inventory = { qcameras: [signed(A, NOW + 3_600_000)], cameras: [signed(A, NOW + 1_800_000)] };
    expect(fileInventoryExpiry(inventory, NOW)).toBe(NOW + 1_800_000 - SIGNED_URL_MARGIN_MS);
    mocks.files.mockResolvedValue(inventory); const h = harness();
    await h.dispatch(fetchFiles(FULL));
    vi.setSystemTime(NOW + 1_500_000);
    expect(selectFiles(h.getState())[`${FULL}--0/qcameras`].url).toBeUndefined();
    await h.dispatch(fetchFiles(FULL)); expect(mocks.files).toHaveBeenCalledTimes(2);
  });

  it('invalidates upload inventories and rejects old file results in both arrival orders', async () => {
    const answers = []; mocks.files.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const h = harness(); const old = h.dispatch(fetchFiles(FULL)); await Promise.resolve();
    h.dispatch(invalidateFiles(FULL)); const fresh = h.dispatch(fetchFiles(FULL, true)); await Promise.resolve();
    answers[0]({ qcameras: [signed(A, NOW + 3_600_000, 'old')] }); await old;
    answers[1]({ qcameras: [signed(A, NOW + 3_600_000, 'fresh')] }); await fresh;
    expect(selectFiles(h.getState())[`${FULL}--0/qcameras`].url).toContain('fresh');
  });

  it('failed requests retry, and logout rejects old completions without blocking a new session', async () => {
    const h = harness(); mocks.files.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ qcameras: [] });
    await h.dispatch(fetchFiles(FULL)); await h.dispatch(fetchFiles(FULL)); expect(mocks.files).toHaveBeenCalledTimes(2);
    let answer; mocks.files.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const old = h.dispatch(fetchFiles(FULL, true)); await Promise.resolve();
    h.dispatch(endSession()); answer({ qcameras: [signed(A, NOW + 3_600_000)] }); await old;
    expect(h.getState().entities.files).toEqual({});
    expect(h.services.resources.pending.size).toBe(0);
  });

  it('does not start a queued request after synchronous logout', async () => {
    const h = harness();
    const pending = h.dispatch(fetchFiles(FULL));
    h.dispatch(endSession());
    await pending;
    expect(mocks.files).not.toHaveBeenCalled();
    expect(h.getState().queries.files).toEqual({});
  });

  it('does not deduplicate subscription and subscribe-info endpoints for the same device', async () => {
    let subscriptionAnswer;
    mocks.subscription.mockImplementation(() => new Promise(resolve => { subscriptionAnswer = resolve; }));
    mocks.info.mockResolvedValue({ eligible: true });
    const h = harness();
    const old = h.dispatch(primeFetchSubscription(A)); await Promise.resolve();
    const state = h.getState();
    h.setState({ ...state, entities: { ...state.entities, devices: { ...state.entities.devices, [A]: { ...state.entities.devices[A], prime: false } } } });
    await h.dispatch(primeFetchSubscription(A));
    subscriptionAnswer({ plan: 'obsolete' }); await old;
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(h.getState().queries.subscriptions[A].subscribeInfo).toEqual({ eligible: true });
    expect(selectSubscription(h.getState(), A)).toBeNull();
  });

  it('invalidation retires the old file request before a non-forced refresh', async () => {
    const answers = []; mocks.files.mockImplementation(() => new Promise(resolve => answers.push(resolve)));
    const h = harness();
    const old = h.dispatch(fetchFiles(FULL)); await Promise.resolve();
    h.dispatch(invalidateFiles(FULL));
    const fresh = h.dispatch(fetchFiles(FULL)); await Promise.resolve();
    expect(mocks.files).toHaveBeenCalledTimes(2);
    answers[0]({ qcameras: [signed(A, NOW + 3_600_000, 'old')] }); await old;
    expect(selectFiles(h.getState())).toBeNull();
    answers[1]({ qcameras: [signed(A, NOW + 3_600_000, 'fresh')] }); await fresh;
    expect(selectFiles(h.getState())[`${FULL}--0/qcameras`].url).toContain('fresh');
  });

  it('new metadata versions hide old file grants and supersede in-flight inventories', async () => {
    const answers = []; mocks.files.mockImplementation(() => new Promise(resolve => answers.push(resolve)));
    const h = harness(); const initial = h.getState();
    h.setState({ ...initial, entities: { ...initial.entities, routes: { [FULL]: { fullname: FULL, maxqlog: 0 } } } });
    const old = h.dispatch(fetchFiles(FULL)); await Promise.resolve();
    const state = h.getState();
    h.setState({ ...state, entities: { ...state.entities, routes: { [FULL]: { fullname: FULL, maxqlog: 1 } } } });
    const fresh = h.dispatch(fetchFiles(FULL)); await Promise.resolve();
    answers[0]({ qcameras: [signed(A, NOW + 3_600_000, 'old')] }); await old;
    expect(selectFiles(h.getState())).toBeNull();
    answers[1]({ qcameras: [signed(A, NOW + 3_600_000, 'fresh')] }); await fresh;
    const newState = h.getState();
    h.setState({ ...newState, entities: { ...newState.entities, routes: { [FULL]: { fullname: FULL, maxqlog: 2 } } } });
    expect(selectFiles(h.getState())[`${FULL}--0/qcameras`].url).toBeUndefined();
  });
});

it('retained file selections keep references across devices and independent stores', () => {
  const makeState = () => {
    const state = createInitialState();
    for (const id of [A, B]) {
      const fullname = `${id}|${LOG}`;
      state.entities.files[`${fullname}--0/qcameras`] = { url: signed(id, NOW + 3_600_000) };
      state.queries.files[fullname] = { status: 'loaded', expiresAt: NOW + 3_300_000 };
    }
    return state;
  };
  const first = makeState();
  const second = makeState();
  const filesA = selectFiles(first, FULL, NOW);
  const filesB = selectFiles(first, `${B}|${LOG}`, NOW);
  selectFiles(second, FULL, NOW);
  expect(selectFiles(first, FULL, NOW)).toBe(filesA);
  expect(selectFiles(first, `${B}|${LOG}`, NOW)).toBe(filesB);
});

it('FINAL_REVIEW an actual billing HTTP500 does not become a fresh null subscription',async()=>{
 const actual=await vi.importActual('../api');actual.billing.configure('token',()=>{});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:500})));
 mocks.subscription.mockImplementation(dongleId=>actual.billing.getSubscription(dongleId));
 const h=harness();await h.dispatch(primeFetchSubscription(A));await h.dispatch(primeFetchSubscription(A));
 vi.unstubAllGlobals();expect(mocks.subscription).toHaveBeenCalledTimes(2);
});


it('a successful HTTP null subscription is cached as an explicit missing result', async () => {
 const actual=await vi.importActual('../api');actual.billing.configure('token',()=>{});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('null',{status:200})));
 mocks.subscription.mockImplementation(dongleId=>actual.billing.getSubscription(dongleId));
 const h=harness();await h.dispatch(primeFetchSubscription(A));await h.dispatch(primeFetchSubscription(A));
 expect(h.getState().queries.subscriptions[A].subscription).toBeNull();
 expect(mocks.subscription).toHaveBeenCalledTimes(1);vi.unstubAllGlobals();
});
