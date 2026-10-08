import * as Sentry from '@sentry/react';
import { athena as Athena, billing as Billing } from '../api';
import { api } from '../api/backend';

import * as Types from './types';
import { getDeviceFromState, deviceVersionAtLeast, deviceIsOnline } from '../utils';
import { hardNavigate } from '../utils/navigation';
import { urlOfRouterLocation } from '../routing/codec';
import { fallbackServices } from '../routing/services';
import { ownedDispatch } from './owned';
import {
  LIMIT_INCREMENT, routeListKey, selectDeviceById, selectLimit, selectListPrefs, selectRouteDetail, selectRoutes,
  selectedRouteFullname,
} from '../selectors';


function normalizeRoute(payload) {
  const r = { ...payload };
  let startTime = r.segment_start_times[0];
  let endTime = r.segment_end_times[r.segment_end_times.length - 1];

  // TODO: these will all be relative times soon
  // fix segment boundary times for routes that have the wrong time at the start
  if ((Math.abs(r.start_time_utc_millis - startTime) > 24 * 60 * 60 * 1000)
      && (Math.abs(r.end_time_utc_millis - endTime) < 10 * 1000)) {
    startTime = r.start_time_utc_millis;
    endTime = r.end_time_utc_millis;
    r.segment_start_times = r.segment_numbers.map((x) => startTime + (x * 60 * 1000));
    r.segment_end_times = r.segment_numbers.map((x) => Math.min(startTime + ((x + 1) * 60 * 1000), endTime));
  }
  // TODO: backwards compatiblity, remove later
  if (r.distance == null && r.length != null) {
    r.distance = r.length;
  }
  return {
    ...r,
    url: r.url.replace('chffrprivate.blob.core.windows.net', 'chffrprivate.azureedge.net'),
    log_id: r.fullname.split('|')[1],
    duration: endTime - startTime,
    start_time_utc_millis: startTime,
    end_time_utc_millis: endTime,
    // TODO: get this from the API, this isn't correct for segments with a time jump
    segment_durations: r.segment_start_times.map((x, i) => r.segment_end_times[i] - x),
  };
}

// Route data is cached per query key (see src/selectors.js). A query is
// loaded when missing or stale, an answer is written to its own key only,
// and identical keys share one request.
export const ROUTES_FRESH_MS = 5 * 60 * 1000;

const isFresh = (entry, now) => Boolean(entry && now - entry.fetchedAt < ROUTES_FRESH_MS);

function runRouteQuery(services, key, force, request, onAnswer) {
  const pending = services.requests.routeQueries.get(key);
  if (pending && !force) return pending;
  services.requests.routeSeq += 1;
  const requestId = services.requests.routeSeq;
  services.requests.routeLatest.set(key, requestId);
  const promise = Promise.resolve().then(request).then((answer) => {
    if (services.requests.routeLatest.get(key) === requestId) return onAnswer(answer, requestId);
    return undefined;
  }).catch((err) => {
    console.error('Failure fetching routes metadata', err);
    Sentry.captureException(err, { fingerprint: 'timeline_fetch_routes' });
  }).finally(() => {
    if (services.requests.routeQueries.get(key) === promise) services.requests.routeQueries.delete(key);
  });
  services.requests.routeQueries.set(key, promise);
  return promise;
}

// The selected device's drive list for its current filter and limit.
export function checkRoutesData({ force = false } = {}) {
  return (rawDispatch, getState, services = fallbackServices) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const state = getState();
    const { dongleId } = state;
    const prefs = selectListPrefs(state);
    if (!dongleId || !prefs) return undefined;
    const { filter, limit } = prefs;
    const key = routeListKey(dongleId, filter, limit);
    if (!force && isFresh(state.queries.routeLists[key], Date.now())) return undefined;
    return runRouteQuery(
      services,
      `list|${state.sessionEpoch}|${key}`, force,
      () => api.routes.getRoutesSegments(dongleId, filter.start, filter.end, limit),
      (data, requestId) => {
        const routes = (data || []).map(normalizeRoute).sort((a, b) => b.create_time - a.create_time);
        dispatch({
          type: Types.ACTION_ROUTE_LIST_LOADED, key, dongleId, start: filter.start, end: filter.end, limit, routes, requestId, fetchedAt: Date.now(),
        });
      },
    );
  };
}

// The selected drive's own metadata, when no list has brought it.
export function checkRouteDetail({ force = false } = {}) {
  return (rawDispatch, getState, services = fallbackServices) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const state = getState();
    const fullname = selectedRouteFullname(state);
    if (!fullname) return undefined;
    const detail = selectRouteDetail(state, fullname);
    const known = state.entities.routes[fullname];
    if (!force && isFresh(detail ?? (known && { fetchedAt: known.metadataFetchedAt }), Date.now())) return undefined;
    const generation = services.navigation.generation;
    const epoch = state.sessionEpoch;
    const [dongleId] = fullname.split('|');
    return runRouteQuery(
      services,
      `detail|${state.sessionEpoch}|${fullname}`, force,
      () => api.routes.getRoutesSegments(dongleId, undefined, undefined, undefined, fullname),
      (data, requestId) => {
        const route = data?.length ? normalizeRoute(data[0]) : null;
        const current = getState();
        if (!route && !api.auth.isAuthenticated()) {
          // signed out and not public: log in, returning to this drive, if it
          // is still the one on screen
          if (current.sessionEpoch === epoch && services.navigation.generation === generation && selectedRouteFullname(current) === fullname) {
            hardNavigate(`/?${new URLSearchParams({ r: urlOfRouterLocation(current.router.location) })}`);
          }
        }
        dispatch({ type: Types.ACTION_ROUTE_DETAIL_LOADED, fullname, route, requestId, fetchedAt: Date.now() });
      },
    );
  };
}

// "Load more": the next page is a new list key.
export function checkLastRoutesData() {
  return (dispatch, getState) => {
    const state = getState();
    const routes = selectRoutes(state);
    const limit = selectLimit(state);
    if (!routes) {
      dispatch(checkRoutesData());
      return;
    }
    // fewer drives than asked for: that was all of them
    if (routes.length < limit) return;
    dispatch({ type: Types.ACTION_UPDATE_ROUTE_LIMIT, dongleId: state.dongleId, limit: limit + LIMIT_INCREMENT });
    dispatch(checkRoutesData());
  };
}

export function primeGetSubscription(dongleId, subscription) {
  return {
    type: Types.ACTION_PRIME_SUBSCRIPTION,
    dongleId,
    subscription,
  };
}

export function primeFetchSubscription(dongleId, device, profile) {
  return (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const state = getState();

    if (!device) {
      device = selectDeviceById(state, dongleId);
    }
    if (!profile && state.profile) {
      profile = state.profile;
    }

    if (device && (device.is_owner || profile?.superuser)) {
      if (device.prime) {
        Billing.getSubscription(dongleId).then((subscription) => {
          dispatch(primeGetSubscription(dongleId, subscription));
        }).catch((err) => {
          console.error(err);
          Sentry.captureException(err, { fingerprint: 'actions_fetch_subscription' });
        });
      } else {
        Billing.getSubscribeInfo(dongleId).then((subscribeInfo) => {
          dispatch({
            type: Types.ACTION_PRIME_SUBSCRIBE_INFO,
            dongleId,
            subscribeInfo,
          });
        }).catch((err) => {
          console.error(err);
          Sentry.captureException(err, { fingerprint: 'actions_fetch_subscribe_info' });
        });
      }
    }
  };
}

export function fetchDeviceOnline(dongleId) {
  return (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    api.devices.fetchDevice(dongleId).then((resp) => {
      dispatch({
        type: Types.ACTION_UPDATE_DEVICE_ONLINE,
        dongleId,
        last_athena_ping: resp.last_athena_ping,
        fetched_at: Math.floor(Date.now() / 1000),
      });
    }).catch(console.log);
  };
}

export function fetchSharedDevice(dongleId) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    try {
      const resp = await api.devices.fetchDevice(dongleId);
      dispatch({
        type: Types.ACTION_UPDATE_SHARED_DEVICE,
        dongleId,
        device: resp,
        fetchedAt: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      if (!err.resp || err.resp.status !== 403) {
        console.error(err);
        Sentry.captureException(err, { fingerprint: 'action_fetch_shared_device' });
      }
    }
  };
}

export function updateDeviceOnline(dongleId, lastAthenaPing) {
  return (dispatch) => {
    dispatch({
      type: Types.ACTION_UPDATE_DEVICE_ONLINE,
      dongleId,
      last_athena_ping: lastAthenaPing,
      fetched_at: Math.floor(Date.now() / 1000),
    });
  };
}

export function fetchDeviceNetworkStatus(dongleId) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const device = getDeviceFromState(getState(), dongleId);
    if (deviceVersionAtLeast(device, '0.8.14')) {
      const payload = {
        id: 0,
        jsonrpc: '2.0',
        method: 'getNetworkMetered',
      };
      try {
        const resp = await Athena.postJsonRpcPayload(dongleId, payload);
        if (resp && resp.result !== undefined) {
          dispatch({
            type: Types.ACTION_UPDATE_DEVICE_NETWORK,
            dongleId,
            networkMetered: resp.result,
          });
          dispatch(updateDeviceOnline(dongleId, Math.floor(Date.now() / 1000)));
        }
      } catch (err) {
        if (err.message && (err.message.indexOf('Timed out') === -1 || err.message.indexOf('Device not registered') === -1)) {
          dispatch(updateDeviceOnline(dongleId, 0));
        } else {
          console.error(err);
          Sentry.captureException(err, { fingerprint: 'athena_fetch_networkmetered' });
        }
      }
    } else {
      const payload = {
        id: 0,
        jsonrpc: '2.0',
        method: 'getNetworkType',
      };
      try {
        const resp = await Athena.postJsonRpcPayload(dongleId, payload);
        if (resp && resp.result !== undefined) {
          const metered = resp.result !== 1 && resp.result !== 6; // wifi or ethernet
          dispatch({
            type: Types.ACTION_UPDATE_DEVICE_NETWORK,
            dongleId,
            networkMetered: metered,
          });
          dispatch(updateDeviceOnline(dongleId, Math.floor(Date.now() / 1000)));
        }
      } catch (err) {
        if (err.message && (err.message.indexOf('Timed out') === -1 || err.message.indexOf('Device not registered') === -1)) {
          dispatch(updateDeviceOnline(dongleId, 0));
        } else {
          console.error(err);
          Sentry.captureException(err, { fingerprint: 'athena_fetch_networktype' });
        }
      }
    }
  };
}

export function fetchDeviceNotCar(dongleId) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const device = getDeviceFromState(getState(), dongleId);
    if (!deviceIsOnline(device)) {
      return;
    }
    const payload = {
      id: 0,
      jsonrpc: '2.0',
      method: 'getNotCar',
    };
    try {
      const resp = await Athena.postJsonRpcPayload(dongleId, payload);
      if (resp && resp.result !== undefined) {
        dispatch({
          type: Types.ACTION_UPDATE_DEVICE_RPC,
          dongleId,
          fields: { not_car: resp.result === true },
        });
      }
    } catch (err) {
      if (!err.message || err.message.indexOf('Device not registered') === -1) {
        console.error(err);
        Sentry.captureException(err, { fingerprint: 'athena_fetch_notcar' });
      }
    }
  };
}

export function updateDevices(devices) {
  return {
    type: Types.ACTION_UPDATE_DEVICES,
    devices,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

export function updateDevice(device) {
  return {
    type: Types.ACTION_UPDATE_DEVICE,
    device,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

export function selectTimeFilter(start, end) {
  return (dispatch, getState) => {
    dispatch({ type: Types.ACTION_SELECT_TIME_FILTER, dongleId: getState().dongleId, start, end });
    dispatch(checkRoutesData());
  };
}

export function analyticsEvent(name, parameters) {
  return {
    type: Types.ANALYTICS_EVENT,
    name,
    parameters,
  };
}

export function updateRoute(fullname, route) {
  return {
    type: Types.ACTION_UPDATE_ROUTE,
    fullname,
    route,
  };
}

// Results for dialogs and pages: each belongs to the session it started in
// (ownedDispatch), so a late answer after logout is dropped by the reducer.

export function refreshDevices() {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const devices = await api.devices.listDevices();
    dispatch(updateDevices(devices));
    return devices;
  };
}

export function renameDevice(dongleId, alias) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const device = await api.devices.setDeviceAlias(dongleId, alias);
    dispatch(updateDevice(device));
    return device;
  };
}

// The subscription, installed when there is one; returns it either way.
export function refreshSubscription(dongleId) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const subscription = await Billing.getSubscription(dongleId);
    if (subscription?.user_id) dispatch(primeGetSubscription(dongleId, subscription));
    return subscription;
  };
}

// Leave for an external page (Stripe) once `getUrl` answers, unless the user
// navigated elsewhere or the session ended meanwhile.
export function leaveForExternalUrl(getUrl) {
  return async (dispatch, getState, services = fallbackServices) => {
    const { revision } = services.navigation;
    const epoch = getState().sessionEpoch;
    const url = await getUrl();
    if (services.navigation.revision !== revision || getState().sessionEpoch !== epoch) return false;
    hardNavigate(url);
    return true;
  };
}
