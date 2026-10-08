import * as Sentry from '@sentry/react';
import { storage as AuthStorage } from '@commaai/my-comma-auth';
import { hardNavigate } from '../utils/navigation';
import { urlOfRouterLocation } from '../routing/codec';

import { api } from '../api/backend';
import { request, athena, billing } from '../api';
import { webrtcConnectionManager } from '../utils/webrtc';
import { clearPairToken } from '../routing/pairToken';
import { fallbackServices } from '../routing/services';
import { stopAllUploadQueuePolls } from './files';
import { clearResourceRequests } from '../resources/requests';
import { assetCacheFor } from '../resources/assetCache';
import { clearClipService } from './clips';

import { ACTION_SESSION_ENDED, ACTION_STARTUP_DATA } from './types';

const SESSION_REJECTED = Symbol('session rejected');

async function initProfile() {
  const { auth, account } = api;
  if (auth.isAuthenticated()) {
    try {
      return await account.getProfile();
    } catch (err) {
      if (err.resp && err.resp.status === 401) {
        // the caller logs out, and only if this session is still the current one
        return SESSION_REJECTED;
      } else {
        console.error(err);
        Sentry.captureException(err, { fingerprint: 'init_api_get_profile' });
      }
    }
  }
  return null;
}

async function initDevices() {
  let devices = [];

  const { auth, devices: devicesApi } = api;
  if (auth.isAuthenticated()) {
    try {
      devices = devices.concat(await devicesApi.listDevices());
    } catch (err) {
      if (!err.resp || err.resp.status !== 401) {
        console.error(err);
        Sentry.captureException(err, { fingerprint: 'init_api_list_devices' });
      }
    }
  }

  return devices;
}

// Load the profile and device list once per store. Independent of the URL:
// navigation effects that need the device list wait on the returned promise.
export function bootstrapSession() {
  return (dispatch, getState, services = fallbackServices) => {
    if (!services.session.promise) {
      const epoch = getState().sessionEpoch;
      const promise = Promise.all([initProfile(), initDevices()]).then(async ([profile, devices]) => {
        if (getState().sessionEpoch !== epoch) {
          // the session ended while loading: nothing of it may be installed,
          // and its refusal must not end the session that replaced it
          return { profile: null, devices: [] };
        }
        if (profile === SESSION_REJECTED) {
          // Invalidate private work immediately. The SDK's higher-level
          // logout redirects after storage yields, outside our epoch guard.
          await dispatch(logOutSession());
          return { profile: null, devices: [] };
        }
        if (profile) {
          Sentry.setUser({ id: profile.id });
        }
        dispatch({ type: ACTION_STARTUP_DATA, profile, devices, epoch, fetchedAt: Math.floor(Date.now() / 1000) });
        return { profile, devices };
      });
      services.session.promise = promise;
    }
    return services.session.promise;
  };
}

// The signed-in session ended (e.g. a 401). Its private state is cleared,
// its bootstrap and in-flight requests are discarded, and late results
// carrying its epoch are ignored by the reducer.
export function endSession() {
  return (dispatch, getState, services = fallbackServices) => {
    clearResourceRequests(services);
    const clearAssets = assetCacheFor(services).clear();
    const clearClips = clearClipService(services);
    services.session.promise = null;
    services.history.reset();
    services.navigation.generation += 1;
    services.navigation.revision += 1;
    services.navigation.pendingCanonical = null;
    webrtcConnectionManager.disconnect();
    request.configure(null);
    athena.configure(null);
    billing.configure(null);
    services.requests.routeQueries.clear();
    services.requests.routeLatest.clear();
    services.commands.pairTokens.clear();
    services.commands.pairPromises?.clear();
    const clearPair = clearPairToken(services).catch((error) => {
      console.error('Could not clear the pairing token', error);
      Sentry.captureException(error, { fingerprint: 'session_clear_pair_token' });
    });
    stopAllUploadQueuePolls(services);
    Sentry.setUser(null);
    dispatch({ type: ACTION_SESSION_ENDED });
    return Promise.all([clearAssets, clearClips, clearPair]);
  };
}


// Navigation must wait for the physical cache clear as well as credentials.
// Capturing the resulting epoch prevents an old logout redirecting a new login.
export function logOutSession({ returnTo = null } = {}) {
  return async (dispatch, getState) => {
    const teardown = dispatch(endSession());
    const epoch = getState().sessionEpoch;
    await Promise.all([teardown, AuthStorage.logOut()]);
    if (getState().sessionEpoch !== epoch) return false;
    hardNavigate(returnTo ?? urlOfRouterLocation(getState().router?.location ?? window.location));
    return true;
  };
}
