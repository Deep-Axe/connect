// Work triggered by a committed navigation. The commit itself (the reducer)
// is synchronous and pure; everything here runs afterwards. Each effect
// states its prerequisites explicitly: effects that need the device list
// wait for the session, and effects that redirect check that their
// navigation is still current.

import { replace } from 'connected-react-router';
import * as Sentry from '@sentry/react';
import localforage from 'localforage';

import { api } from '../api/backend';
import {
  checkLastRoutesData, checkRoutesData, fetchDeviceOnline, fetchSharedDevice, primeFetchSubscription,
} from '../actions';
import { ACTION_PAIR_REQUESTED, ACTION_PRIME_STRIPE_RESULT } from '../actions/types';
import { bootstrapSession } from '../actions/session';
import { webrtcConnectionManager } from '../utils/webrtc';
import { getDeviceFromState } from '../utils';
import {
  VIEWS, buildUrl, deviceBase, driveBase, isSafeReturnUrl, locationFor, withoutCommands,
} from './codec';

const CONSUMED_COMMANDS = ['pair', 'stripe_success', 'stripe_cancelled'];

function rememberedOrFirstDevice(devices) {
  const remembered = window.localStorage.getItem('selectedDongleId');
  return devices.find((d) => d.dongle_id === remembered) || devices[0] || null;
}

// A pair token from the URL is stored (it survives a login redirect) and
// handed to the explorer, once per token per session.
async function receivePairToken(token, ctx) {
  const { pairTokens } = ctx.services.commands;
  if (pairTokens.has(token)) return;
  pairTokens.add(token);
  const epoch = ctx.getState().sessionEpoch;
  try {
    await localforage.setItem('pairToken', token);
  } catch (err) {
    console.error(err);
    pairTokens.delete(token); // not stored: the same link may try again
    return;
  }
  if (ctx.getState().sessionEpoch !== epoch) return;
  ctx.dispatch({ type: ACTION_PAIR_REQUESTED });
}

// One-shot query arguments: act on them, then drop them from the URL. Returns
// true only when the location is being replaced by a different page (a
// post-login return target); otherwise the page's own effects still run, and
// the follow-up commit without the arguments is a no-op.
function consumeCommands(next, ctx) {
  const { commands, base } = next;
  const { dispatch } = ctx;
  const consumed = [];

  // post-login return target; anonymous visitors keep it for the landing page
  if (commands.r != null && api.auth.isAuthenticated()) {
    if (isSafeReturnUrl(commands.r)) {
      dispatch(replace(commands.r));
      return true;
    }
    consumed.push('r');
  }

  if (commands.stripe_success != null || commands.stripe_cancelled != null) {
    dispatch({
      type: ACTION_PRIME_STRIPE_RESULT,
      dongleId: base.dongleId,
      success: commands.stripe_success ?? null,
      cancelled: commands.stripe_cancelled ?? null,
    });
  }

  if (commands.pair) receivePairToken(commands.pair, ctx);

  consumed.push(...CONSUMED_COMMANDS.filter((key) => commands[key] != null));
  // rewrite only the exact location the commands came from; a newer one (even
  // on the same page) is left as it is
  if (consumed.length && ctx.isLatest()) {
    dispatch(replace(buildUrl(withoutCommands(next, consumed))));
  }
  return false;
}

// `/` shows the remembered or first device, keeping the global arguments
// and the hash
async function resolveRoot(next, ctx) {
  if (!api.auth.isAuthenticated()) return;
  const { devices } = await ctx.session();
  if (!ctx.isCurrent()) return;
  const device = rememberedOrFirstDevice(devices || []);
  if (device) {
    // from the latest location on this page, which may carry newer context
    const latest = ctx.latestLocation();
    const target = { ...locationFor(deviceBase(VIEWS.DASHBOARD, device.dongle_id), latest), hash: latest.hash };
    ctx.dispatch(replace(buildUrl(target)));
  }
}

// an old timestamp link names the same drive: keep everything else it carried
async function resolveLegacyRange(next, ctx) {
  const { base } = next;
  try {
    const routes = await api.routes.getRoutesSegments(base.dongleId, base.legacyRange.start, base.legacyRange.end);
    if (!ctx.isCurrent()) return;
    const logId = routes?.[0]?.fullname?.split('|')[1];
    if (logId) {
      // from the latest location on this page, which may carry newer context
      ctx.dispatch(replace(buildUrl({ ...ctx.latestLocation(), commands: {}, base: driveBase(base.dongleId, logId) })));
    }
  } catch (err) {
    console.error('Error fetching routes data for log ID conversion', err);
  }
}

async function selectedDeviceChanged(dongleId, ctx) {
  const { dispatch, getState } = ctx;
  window.localStorage.setItem('selectedDongleId', dongleId);

  const { devices, profile } = await ctx.session();
  if (getState().dongleId !== dongleId) return;
  const device = (devices || []).find((d) => d.dongle_id === dongleId);
  if ((device && !device.shared) || profile?.superuser) {
    dispatch(primeFetchSubscription(dongleId, device, profile));
    dispatch(fetchDeviceOnline(dongleId));
  }
  if (!device && api.auth.isAuthenticated()) {
    dispatch(fetchSharedDevice(dongleId));
  }
}

function ensureRoutes(ctx) {
  // limit 0 means nothing has been requested for this device yet
  ctx.dispatch(ctx.getState().limit === 0 ? checkLastRoutesData() : checkRoutesData());
}

// pages that show the device's drives
const ROUTE_VIEWS = [VIEWS.DASHBOARD, VIEWS.DRIVE];

export function runNavigationEffects(previous, next, ctx) {
  const { base } = next;
  // superseded before it ran, or an invalid link: nothing to do
  if (!ctx.isCurrent() || base.view === VIEWS.INVALID) return;
  if (consumeCommands(next, ctx)) return;

  const run = (effect) => Promise.resolve().then(effect).catch((err) => {
    console.error(err);
    Sentry.captureException(err, { fingerprint: 'navigation_effect' });
  });

  // the stream connection: compare where we are with who actually holds it
  // (not with the previous URL: an intermediate page may never have run its
  // effects); the connection manager decides what stays open
  const { dongleId } = ctx.getState();
  const deviceChanged = Boolean(base.dongleId && dongleId === base.dongleId && dongleId !== ctx.previousDongleId);
  const streaming = webrtcConnectionManager.streamDongleId;
  if (streaming && !(base.view === VIEWS.STREAM && base.dongleId === streaming)) {
    // a comma body stays warm for a quick return; a car's connection closes
    const left = getDeviceFromState(ctx.getState(), streaming);
    webrtcConnectionManager.leaveStream(streaming, { keepWarm: Boolean(left?.rpc?.not_car) });
  }
  if (deviceChanged) webrtcConnectionManager.deviceChanged(dongleId);
  if (base.view === VIEWS.STREAM) webrtcConnectionManager.enterStream(base.dongleId);

  if (base.view === VIEWS.ROOT) run(() => resolveRoot(next, ctx));
  if (base.view === VIEWS.LEGACY_RANGE) run(() => resolveLegacyRange(next, ctx));

  if (deviceChanged) run(() => selectedDeviceChanged(dongleId, ctx));
  if (base.dongleId && dongleId === base.dongleId && ROUTE_VIEWS.includes(base.view)) {
    ensureRoutes(ctx);
  }
}

export function createEffectContext(store, services, generation, revision, previousDongleId) {
  return {
    dispatch: store.dispatch,
    getState: store.getState,
    services,
    previousDongleId,
    // still the same page (loads, redirects)
    isCurrent: () => services.navigation.generation === generation,
    // still exactly this location (rewriting the URL in place)
    isLatest: () => services.navigation.revision === revision,
    latestLocation: () => store.getState().nav.location,
    session: () => store.dispatch(bootstrapSession()),
  };
}
