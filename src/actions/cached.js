import * as Sentry from '@sentry/react';

import * as Types from './types';
import { api } from '../api/backend';
import { reverseLookup } from '../utils/geocode';
import { ownedDispatch } from './owned';
import { fallbackServices } from '../routing/services';

const USE_LOCAL_COORDS_DATA = import.meta.env.VITE_APP_LOCAL_COORDS_DATA === 'true';
if (USE_LOCAL_COORDS_DATA) {
  console.warn('using local coords data');
}
const USE_LOCAL_EVENTS_DATA = import.meta.env.VITE_APP_LOCAL_EVENTS_DATA === 'true';
if (USE_LOCAL_EVENTS_DATA) {
  console.warn('using local events data');
}

let hasExpired = false;
let cacheDB = null;

async function getCacheDB() {
  if (cacheDB !== null) {
    return Promise.resolve(cacheDB);
  }

  if (!window.indexedDB) {
    return Promise.resolve(null);
  }

  let request;
  try {
    request = window.indexedDB.open('cacheDB', 2);
  } catch (err) {
    console.error(err);
    Sentry.captureException(err, { fingerprint: 'cached_open_indexeddb' });
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    request.onerror = (ev) => {
      console.log(ev.target.error);
      resolve(null);
    };
    request.onsuccess = (ev) => {
      const db = ev.target.result;
      for (const store of ['events', 'coords', 'driveCoords']) {
        if (!db.objectStoreNames.contains(store)) {
          console.log('cannot find store in indexedDB', store);
          resolve(null);
        }
      }
      cacheDB = db;
      resolve(db);
    };
    request.onupgradeneeded = (ev) => {
      const db = ev.target.result;

      for (const store of db.objectStoreNames) {
        try {
          db.deleteObjectStore(store);
        } catch (err) {
          console.error(err);
          Sentry.captureException(err, { fingerprint: 'cached_delete_obj_store' });
          resolve(null);
          return;
        }
      }

      const routeStore = db.createObjectStore('events', { keyPath: 'key' });
      routeStore.createIndex('key', 'key', { unique: true });
      routeStore.createIndex('expiry', 'expiry', { unique: false });
      const coordsStore = db.createObjectStore('coords', { keyPath: 'key' });
      coordsStore.createIndex('key', 'key', { unique: true });
      coordsStore.createIndex('expiry', 'expiry', { unique: false });
      const driveCoordsStore = db.createObjectStore('driveCoords', { keyPath: 'key' });
      driveCoordsStore.createIndex('key', 'key', { unique: true });
      driveCoordsStore.createIndex('expiry', 'expiry', { unique: false });
    };
  });
}

async function expireCacheItems(store) {
  const db = await getCacheDB();
  if (!db) {
    return;
  }

  const transaction = db.transaction([store], 'readwrite');
  const objStore = transaction.objectStore(store);

  const idx = IDBKeyRange.upperBound(Math.floor(Date.now() / 1000));
  const req = objStore.index('expiry').openCursor(idx);
  req.onsuccess = (ev) => {
    const cursor = ev.target.result;
    if (cursor) {
      objStore.delete(cursor.primaryKey);
      cursor.continue();
    }
  };
}

async function getCacheItem(store, key, version = undefined) {
  if (!hasExpired) {
    setTimeout(() => expireCacheItems(store), 5000); // TODO: better expire time
    hasExpired = true;
  }

  const db = await getCacheDB();
  if (!db) {
    return null;
  }

  const transaction = db.transaction([store]);
  const req = transaction.objectStore(store).get(key);

  return new Promise((resolve, reject) => {
    req.onsuccess = (ev) => {
      if (ev.target.result !== undefined && (version === undefined || ev.target.result.version >= version)) {
        resolve(ev.target.result.data);
      } else {
        resolve(null);
      }
    };
    req.onerror = (ev) => reject(ev.target.error);
  });
}

async function setCacheItem(store, key, expiry, data, version = undefined) {
  const db = await getCacheDB();
  if (!db) {
    return null;
  }

  const transaction = db.transaction([store], 'readwrite');
  const val = { key, expiry, data };
  if (version !== undefined) {
    val.version = version;
  }
  const req = transaction.objectStore(store).put(val);

  return new Promise((resolve, reject) => {
    req.onsuccess = (ev) => resolve(ev.target.result);
    req.onerror = (ev) => reject(ev.target.error);
  });
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

// In-flight asset requests, per store (see routing/services). A request
// leaves its map as soon as it settles, success or failure, so a failure can
// be retried; settled data lives in IndexedDB and Redux, not here.
function inFlight(map, key, load) {
  if (!map.has(key)) {
    const request = Promise.resolve().then(load).catch((err) => {
      console.error(err);
      return null;
    }).finally(() => {
      if (map.get(key) === request) map.delete(key);
    });
    map.set(key, request);
  }
  return map.get(key);
}

// A segment's asset file: 404 means the file doesn't exist (an empty part);
// any other failure fails the whole request, so it is not remembered as
// loaded and can be retried.
async function assetJson(resp) {
  if (resp.ok) return resp.json();
  if (resp.status === 404) return [];
  throw new Error(`asset request failed: HTTP ${resp.status}`);
}

function routeLoaded(state, route, field) {
  const loaded = state.entities?.routes?.[route.fullname];
  return Boolean(loaded?.[field]);
}

export function fetchEvents(route) {
  return async (rawDispatch, getState, services = fallbackServices) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const state = getState();
    if (!state.entities?.routes?.[route.fullname] || routeLoaded(state, route, 'events')) {
      return;
    }

    // events depend on how many qlogs the route has (maxqlog)
    const driveEvents = await inFlight(services.requests.events, `${route.fullname}|${route.maxqlog}`, async () => {
      if (!USE_LOCAL_EVENTS_DATA) {
        const cacheEvents = await getCacheItem('events', route.fullname, route.maxqlog);
        if (cacheEvents !== null) return cacheEvents;
      }
      const parts = await Promise.all(Array.from({ length: route.maxqlog + 1 }, async (_, j) => {
        const url = new URL(api.routeAssets.events(route, j));
        if (USE_LOCAL_EVENTS_DATA) {
          url.hostname = 'chffrprivate.azureedge.local';
        }
        const resp = await fetch(url, { method: 'GET' });
        return assetJson(resp);
      }));
      const events = parseEvents(route, [].concat(...parts));
      if (!USE_LOCAL_EVENTS_DATA) {
        setCacheItem('events', route.fullname, Math.floor(Date.now() / 1000) + (86400 * 14), events, route.maxqlog);
      }
      return events;
    });
    if (driveEvents === null) return;

    dispatch({
      type: Types.ACTION_UPDATE_ROUTE_EVENTS,
      fullname: route.fullname,
      maxqlog: route.maxqlog,
      events: driveEvents,
    });
  };
}

export function fetchCoord(route, coord, locationKey) {
  return async (rawDispatch, getState, services = fallbackServices) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const state = getState();
    if (!state.entities?.routes?.[route.fullname] || (!coord[0] && !coord[1]) || routeLoaded(state, route, locationKey)) {
      return;
    }

    // round for better caching
    coord[0] = Math.round(coord[0] * 1000) / 1000;
    coord[1] = Math.round(coord[1] * 1000) / 1000;

    const location = await inFlight(services.requests.coords, JSON.stringify(coord), async () => {
      const cacheCoords = await getCacheItem('coords', coord);
      if (cacheCoords !== null) return cacheCoords;
      const found = await reverseLookup(coord);
      if (found) setCacheItem('coords', coord, Math.floor(Date.now() / 1000) + (86400 * 14), found);
      return found || null;
    });
    if (!location) return;

    dispatch({
      type: Types.ACTION_UPDATE_ROUTE_LOCATION,
      fullname: route.fullname,
      locationKey,
      location,
    });
  };
}

export function fetchLocations(route) {
  return (dispatch, getState) => {
    dispatch(fetchCoord(route, [route.start_lng, route.start_lat], 'startLocation'));
    dispatch(fetchCoord(route, [route.end_lng, route.end_lat], 'endLocation'));
  };
}

export function fetchDriveCoords(route) {
  return async (rawDispatch, getState, services = fallbackServices) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const state = getState();
    if (!state.entities?.routes?.[route.fullname] || routeLoaded(state, route, 'driveCoords')) {
      return;
    }

    const driveCoords = await inFlight(services.requests.driveCoords, `${route.fullname}|${route.maxqlog}`, async () => {
      if (!USE_LOCAL_COORDS_DATA) {
        const cacheDriveCoords = await getCacheItem('driveCoords', route.fullname, route.maxqlog);
        if (cacheDriveCoords !== null) return cacheDriveCoords;
      }
      const parts = await Promise.all(Array.from({ length: route.maxqlog + 1 }, async (_, j) => {
        const url = new URL(api.routeAssets.coords(route, j));
        if (USE_LOCAL_COORDS_DATA) {
          url.hostname = 'chffrprivate.azureedge.local';
        }
        const resp = await fetch(url, { method: 'GET' });
        return assetJson(resp);
      }));
      const coords = parts.reduce((prev, curr) => ({
        ...prev,
        ...curr.reduce((p, cs) => {
          p[cs.t] = [cs.lng, cs.lat];
          return p;
        }, {}),
      }), {});
      if (!USE_LOCAL_COORDS_DATA) {
        setCacheItem('driveCoords', route.fullname, Math.floor(Date.now() / 1000) + (86400 * 14), coords, route.maxqlog);
      }
      return coords;
    });
    if (driveCoords === null) return;

    dispatch({
      type: Types.ACTION_UPDATE_ROUTE,
      fullname: route.fullname,
      maxqlog: route.maxqlog,
      route: {
        driveCoords,
      },
    });
  };
}
