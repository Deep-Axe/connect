import * as Sentry from '@sentry/react';

import * as Types from './types';
import { api } from '../api/backend';
import { reverseLookup } from '../utils/geocode';
import { assetCacheFor } from '../resources/assetCache';
import { runResourceRequest } from '../resources/requests';
import { fallbackServices } from '../routing/services';

const ASSET_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;

function assetExpiry() {
  return Math.floor(Date.now() / 1000) + ASSET_CACHE_TTL_SECONDS;
}

function reportAssetError(error) {
  console.error(error);
  Sentry.captureException(error);
  return null;
}

const USE_LOCAL_COORDS_DATA = import.meta.env.VITE_APP_LOCAL_COORDS_DATA === 'true';
if (USE_LOCAL_COORDS_DATA) {
  console.warn('using local coords data');
}
const USE_LOCAL_EVENTS_DATA = import.meta.env.VITE_APP_LOCAL_EVENTS_DATA === 'true';
if (USE_LOCAL_EVENTS_DATA) {
  console.warn('using local events data');
}

function parseEvents(route, driveEvents) {
  // sort events
  driveEvents.sort((a, b) => {
    if (a.route_offset_millis === b.route_offset_millis) {
      return a.route_offset_nanos - b.route_offset_nanos;
    }
    return a.route_offset_millis - b.route_offset_millis;
  });

  // create useful drive events from data
  let res = [];
  let currEngaged = null;
  let currAlert = null;
  let currOverride = null;
  let lastEngage = null;
  let currBookmark = null;
  for (const ev of driveEvents) {
    if (ev.type === 'state') {
      if (currEngaged !== null && !ev.data.enabled) {
        currEngaged.data.end_route_offset_millis = ev.route_offset_millis;
        currEngaged = null;
      }
      if (currEngaged === null && ev.data.enabled) {
        currEngaged = {
          ...ev,
          data: { ...ev.data },
          type: 'engage',
        };
        res.push(currEngaged);
      }

      if (currAlert !== null && ev.data.alertStatus !== currAlert.data.alertStatus) {
        currAlert.data.end_route_offset_millis = ev.route_offset_millis;
        currAlert = null;
      }
      if (currAlert === null && ev.data.alertStatus !== 'normal') {
        currAlert = {
          ...ev,
          data: { ...ev.data },
          type: 'alert',
        };
        res.push(currAlert);
      }

      if (currOverride !== null && ev.data.state !== currOverride.data.state) {
        currOverride.data.end_route_offset_millis = ev.route_offset_millis;
        currOverride = null;
      }
      if (currOverride === null && ['overriding', 'preEnabled'].includes(ev.data.state)) {
        currOverride = {
          ...ev,
          data: { ...ev.data },
          type: 'overriding',
        };
        res.push(currOverride);
      }
    } else if (ev.type === 'engage') {
      lastEngage = {
        ...ev,
        data: { ...ev.data },
      };
      res.push(lastEngage);
    } else if (ev.type === 'disengage' && lastEngage) {
      lastEngage.data = {
        end_route_offset_millis: ev.route_offset_millis,
      };
    } else if (ev.type === 'alert') {
      res.push(ev);
    } else if (ev.type === 'event') {
      res.push(ev);
    } else if (ev.type === 'user_bookmark' || ev.type === 'user_flag') {
      currBookmark = {
        ...ev,
        data: {
          ...ev.data,
          end_route_offset_millis: ev.route_offset_millis + 1e3,
        },
        type: 'bookmark',
      };
      res.push(currBookmark);
    }
  }

  // make sure events have an ending
  if (currEngaged !== null) {
    currEngaged.data.end_route_offset_millis = route.duration;
  }
  if (currAlert !== null) {
    currAlert.data.end_route_offset_millis = route.duration;
  }
  if (currOverride !== null) {
    currOverride.data.end_route_offset_millis = route.duration;
  }
  if (lastEngage && lastEngage.data?.end_route_offset_millis === undefined) {
    lastEngage.data = {
      end_route_offset_millis: route.duration,
    };
  }

  // reduce size, keep only used data
  res = res.map((ev) => ({
    type: ev.type,
    route_offset_millis: ev.route_offset_millis,
    data: {
      state: ev.data.state,
      event_type: ev.data.event_type,
      alertStatus: ev.data.alertStatus,
      end_route_offset_millis: ev.data.end_route_offset_millis,
    },
  }));

  return res;
}

// A 404 denotes a missing segment; transport and parse failures remain retryable.
async function assetJson(resp) {
  if (resp.ok) return resp.json();
  if (resp.status === 404) return [];
  throw new Error(`asset request failed: HTTP ${resp.status}`);
}

function assetOwner(getState, route) {
  const epoch = getState().sessionEpoch;
  return () => {
    const current = getState().entities?.routes?.[route.fullname];
    return Boolean(current && getState().sessionEpoch === epoch && current.maxqlog === route.maxqlog);
  };
}

function routeLoaded(state, route, field) {
  const loaded = state.entities.routes[route.fullname];
  return loaded?.[field] !== undefined && loaded[`${field}Version`] === route.maxqlog;
}

async function loadParts(route, getUrl, local, isCurrent) {
  return Promise.all(Array.from({ length: route.maxqlog + 1 }, async (_, segment) => {
    if (!isCurrent()) throw new Error('Asset request superseded');
    const url = new URL(getUrl(route, segment));
    if (local) url.hostname = 'chffrprivate.azureedge.local';
    const resp = await fetch(url.href, { method: 'GET' });
    return assetJson(resp);
  }));
}

export function fetchEvents(route) {
  return (dispatch, getState, services = fallbackServices) => {
    const isCurrent = assetOwner(getState, route);
    if (!isCurrent() || routeLoaded(getState(), route, 'events')) return Promise.resolve();
    const cache = assetCacheFor(services);
    return runResourceRequest(services, getState, `events|${route.fullname}|${route.maxqlog}`, async () => {
      if (!USE_LOCAL_EVENTS_DATA) {
        const stored = await cache.read('events', route.fullname, route.maxqlog, isCurrent);
        if (stored !== null) return stored;
      }
      if (!isCurrent()) return null;
      const parts = await loadParts(route, api.routeAssets.events, USE_LOCAL_EVENTS_DATA, isCurrent);
      const events = parseEvents(route, [].concat(...parts));
      if (!USE_LOCAL_EVENTS_DATA) {
        await cache.write('events', route.fullname, assetExpiry(), events, route.maxqlog, isCurrent);
      }
      return events;
    }, (events, ownership) => {
      if (events !== null && isCurrent()) {
        dispatch({
          type: Types.ACTION_UPDATE_ROUTE_EVENTS,
          fullname: route.fullname,
          maxqlog: route.maxqlog,
          events,
          epoch: ownership.epoch,
          requestId: ownership.requestId,
        });
      }
    }).catch(reportAssetError);
  };
}

export function fetchCoord(route, coordinate, locationKey) {
  return (dispatch, getState, services = fallbackServices) => {
    const epoch = getState().sessionEpoch;
    const prefix = locationKey === 'startLocation' ? 'start' : 'end';
    const isCurrent = () => {
      const current = getState().entities?.routes?.[route.fullname];
      return getState().sessionEpoch === epoch && current
        && current[`${prefix}_lng`] === route[`${prefix}_lng`] && current[`${prefix}_lat`] === route[`${prefix}_lat`];
    };
    if (!isCurrent()) return Promise.resolve();
    const hasCoordinates = Boolean(coordinate[0] || coordinate[1]);
    const loadedLocation = getState().entities.routes[route.fullname][locationKey];
    if (!hasCoordinates || loadedLocation) return Promise.resolve();
    const coord = coordinate.map(value => Math.round(value * 1000) / 1000);
    const cache = assetCacheFor(services);
    return runResourceRequest(services, getState, `coords|${route.fullname}|${locationKey}|${JSON.stringify(coord)}`, async () => {
      const stored = await cache.read('coords', coord, undefined, isCurrent);
      if (stored !== null) return stored;
      if (!isCurrent()) return null;
      const found = await reverseLookup(coord);
      if (found) {
        await cache.write('coords', coord, assetExpiry(), found, undefined, isCurrent);
      }
      return found || null;
    }, (location, ownership) => {
      if (location && isCurrent()) {
        dispatch({
          type: Types.ACTION_UPDATE_ROUTE_LOCATION,
          fullname: route.fullname,
          locationKey,
          location,
          epoch: ownership.epoch,
          requestId: ownership.requestId,
        });
      }
    }).catch(reportAssetError);
  };
}

export function fetchLocations(route) {
  return (dispatch) => Promise.all([
    dispatch(fetchCoord(route, [route.start_lng, route.start_lat], 'startLocation')),
    dispatch(fetchCoord(route, [route.end_lng, route.end_lat], 'endLocation')),
  ]);
}

export function fetchDriveCoords(route) {
  return (dispatch, getState, services = fallbackServices) => {
    const isCurrent = assetOwner(getState, route);
    if (!isCurrent() || routeLoaded(getState(), route, 'driveCoords')) return Promise.resolve();
    const cache = assetCacheFor(services);
    return runResourceRequest(services, getState, `driveCoords|${route.fullname}|${route.maxqlog}`, async () => {
      if (!USE_LOCAL_COORDS_DATA) {
        const stored = await cache.read('driveCoords', route.fullname, route.maxqlog, isCurrent);
        if (stored !== null) return stored;
      }
      if (!isCurrent()) return null;
      const parts = await loadParts(route, api.routeAssets.coords, USE_LOCAL_COORDS_DATA, isCurrent);
      const coords = Object.fromEntries(parts.flat().map(coord => [coord.t, [coord.lng, coord.lat]]));
      if (!USE_LOCAL_COORDS_DATA) {
        await cache.write('driveCoords', route.fullname, assetExpiry(), coords, route.maxqlog, isCurrent);
      }
      return coords;
    }, (driveCoords, ownership) => {
      if (driveCoords !== null && isCurrent()) {
        dispatch({
          type: Types.ACTION_UPDATE_ROUTE,
          fullname: route.fullname,
          maxqlog: route.maxqlog,
          route: { driveCoords, driveCoordsVersion: route.maxqlog },
          epoch: ownership.epoch,
          requestId: ownership.requestId,
        });
      }
    }).catch(reportAssetError);
  };
}
