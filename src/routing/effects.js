// Work triggered by a committed navigation. The commit itself (the reducer)
// is synchronous and pure; everything here runs afterwards. Each effect
// states its prerequisites explicitly: effects that need the device list
// wait for the session, and effects that redirect check that their
// navigation is still current.

import { replace } from 'connected-react-router';
import * as Sentry from '@sentry/react';

import { api } from '../api/backend';
import {
  checkLastRoutesData, checkRoutesData, fetchDeviceOnline, fetchSharedDevice, primeFetchSubscription,
} from '../actions';
import { ACTION_PRIME_STRIPE_RESULT } from '../actions/types';
import { bootstrapSession } from '../actions/session';
import { webrtcConnectionManager } from '../utils/webrtc';
import { VIEWS, buildUrl, isSafeReturnUrl, withoutCommands } from './codec';

const CONSUMED_COMMANDS = ['pair', 'stripe_success', 'stripe_cancelled'];

function rememberedOrFirstDevice(devices) {
  const remembered = window.localStorage.getItem('selectedDongleId');
  return devices.find((d) => d.dongle_id === remembered) || devices[0] || null;
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

  // the pair token was stored by App before routing started
  consumed.push(...CONSUMED_COMMANDS.filter((key) => commands[key] != null));
  if (consumed.length) {
    dispatch(replace(buildUrl(withoutCommands(next, consumed))));
  }
  return false;
}

async function resolveRoot(ctx) {
  if (!api.auth.isAuthenticated()) return;
  const { devices } = await ctx.session();
  if (!ctx.isCurrent()) return;
  const device = rememberedOrFirstDevice(devices || []);
  if (device) ctx.dispatch(replace(`/${device.dongle_id}`));
}

async function resolveLegacyRange(base, ctx) {
  try {
    const routes = await api.routes.getRoutesSegments(base.dongleId, base.legacyRange.start, base.legacyRange.end);
    if (!ctx.isCurrent()) return;
    const logId = routes?.[0]?.fullname?.split('|')[1];
    if (logId) ctx.dispatch(replace(`/${base.dongleId}/${logId}`));
  } catch (err) {
    console.error('Error fetching routes data for log ID conversion', err);
  }
}

async function selectedDeviceChanged(dongleId, ctx) {
  const { dispatch, getState } = ctx;
  if (ctx.previousDongleId) {
    webrtcConnectionManager.disconnect();
  }
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

export function runNavigationEffects(previous, next, ctx) {
  const { base } = next;
  if (consumeCommands(next, ctx)) return;

  const run = (effect) => Promise.resolve().then(effect).catch((err) => {
    console.error(err);
    Sentry.captureException(err, { fingerprint: 'navigation_effect' });
  });

  if (base.view === VIEWS.ROOT) run(() => resolveRoot(ctx));
  if (base.view === VIEWS.LEGACY_RANGE) run(() => resolveLegacyRange(base, ctx));

  const { dongleId } = ctx.getState();
  if (base.dongleId && dongleId === base.dongleId) {
    if (dongleId !== ctx.previousDongleId) run(() => selectedDeviceChanged(dongleId, ctx));
    ensureRoutes(ctx);
  }
}

export function createEffectContext(store, services, generation, previousDongleId) {
  return {
    dispatch: store.dispatch,
    getState: store.getState,
    previousDongleId,
    isCurrent: () => services.navigation.generation === generation,
    session: () => store.dispatch(bootstrapSession()),
  };
}

