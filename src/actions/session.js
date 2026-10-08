import * as Sentry from '@sentry/react';

import { api } from '../api/backend';
import { fallbackServices } from '../routing/services';

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
          // the token was refused: end the session like any other logout
          await api.auth.logOut();
          if (getState().sessionEpoch === epoch) dispatch(endSession());
          return { profile: null, devices: [] };
        }
        if (profile) {
          Sentry.setUser({ id: profile.id });
        }
        dispatch({ type: ACTION_STARTUP_DATA, profile, devices, epoch });
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
    services.session.promise = null;
    services.requests.routes = null;
    services.requests.routesLatest.clear();
    services.requests.events.clear();
    services.requests.coords.clear();
    services.requests.driveCoords.clear();
    services.commands.pairTokens.clear();
    if (services.uploads.timer) clearTimeout(services.uploads.timer);
    services.uploads.timer = null;
    services.uploads.run += 1;
    Sentry.setUser(null);
    dispatch({ type: ACTION_SESSION_ENDED });
  };
}
