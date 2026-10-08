import * as Types from '../actions/types';
import { emptyDevice } from '../utils/emptyDevice';
import { getDefaultFilter } from '../utils/filter';
import { offsetAt } from '../timeline/offset';

const eventsMap = {};
const locationMap = {};

// ---- devices: stored once, by id (entities.devices), with the account's
// sorted list as ids (entities.deviceOrder). The selected device is derived
// (selectors.selectDevice), never copied.

function withDevices(state, devices, deviceOrder = state.entities.deviceOrder) {
  return { ...state, entities: { ...state.entities, devices, deviceOrder } };
}

// Merge into one device, creating it (from the shared-device placeholder)
// if this is the first we hear of it.
function updateDeviceEntity(state, dongleId, update) {
  const previous = state.entities.devices[dongleId] ?? { ...emptyDevice, dongle_id: dongleId };
  return withDevices(state, { ...state.entities.devices, [dongleId]: update(previous) });
}

// The account's device list: listed devices are replaced by the new payload,
// keeping Athena RPC-fetched values (`rpc`) the payload doesn't carry.
function setDeviceList(state, list, fetchedAt) {
  const devices = { ...state.entities.devices };
  list.forEach((device) => {
    const previous = devices[device.dongle_id];
    devices[device.dongle_id] = {
      ...device,
      ...(previous?.rpc ? { rpc: previous.rpc } : {}),
      fetched_at: fetchedAt,
    };
  });
  const order = list.map((d) => devices[d.dongle_id]).sort(deviceCompareFn).map((d) => d.dongle_id);
  return withDevices(state, devices, order);
}

function deviceCompareFn(a, b) {
  if (a.is_owner !== b.is_owner) {
    return b.is_owner - a.is_owner;
  }
  if (a.alias && b.alias) {
    return a.alias.localeCompare(b.alias);
  }
  if (!a.alias && !b.alias) {
    return a.dongle_id.localeCompare(b.dongle_id);
  }
  return Boolean(b.alias) - Boolean(a.alias);
}

function applySelectedDevice(state, dongleId) {
  // interim per-device reset: until resources are keyed by device, data
  // loaded for the previous device must not show under the new one
  const sameRoutes = state.routesMeta && state.routesMeta.dongleId === dongleId;
  return {
    ...state,
    dongleId,
    filter: getDefaultFilter(),
    subscription: null,
    subscribeInfo: null,
    primeStripeResult: null,
    files: null,
    missingRoute: null,
    limit: 0,
    ...(sameRoutes ? {} : {
      routesMeta: { dongleId: null, start: null, end: null },
      routes: null,
      lastRoutes: null,
      currentRoute: null,
    }),
  };
}

// Effective bounds: the URL's selection intersected with the route, so a
// range rounded up past the end of the drive plays to the end without
// rewriting the URL. A selection entirely after the end has no effective
// bounds (null); the drive view shows it as an invalid selection.
function effectiveZoom(drive, route) {
  if (drive.start == null) {
    return route ? { start: 0, end: route.duration } : null;
  }
  if (route && drive.start >= route.duration) {
    return null;
  }
  if (route && drive.start < route.duration && drive.end > route.duration) {
    return { start: drive.start, end: route.duration };
  }
  return { start: drive.start, end: drive.end };
}

// Apply the drive selection named by the URL to zoom/loop/playback. A
// modal-only or query-only change keeps everything; a new range keeps the
// playhead when it is still inside it.
function applySelectedDrive(state, previousBase, base, at) {
  const drive = base.drive;
  const previousDrive = previousBase?.dongleId === base.dongleId ? previousBase?.drive : null;

  if (!drive) {
    if (previousDrive) state.files = null;
    state.zoom = null;
    state.loop = null;
    state.currentRoute = null;
    return state;
  }

  const sameDrive = previousDrive?.logId === drive.logId;
  if (sameDrive && previousDrive.start === drive.start && previousDrive.end === drive.end && state.zoom) {
    return state;
  }

  const currentRoute = state.routes?.find((route) => route.log_id === drive.logId) || null;
  const zoom = effectiveZoom(drive, currentRoute);

  if (!sameDrive || !state.zoom || drive.start == null || !zoom
    || zoom.start < state.zoom.start || zoom.end > state.zoom.end) {
    state.files = null;
  }
  // where playback actually is right now (offset is only an anchor: playing
  // advances from it since startTime), under the old selection
  const position = sameDrive && state.offset != null ? offsetAt(state, at) : null;
  state.currentRoute = currentRoute;
  state.zoom = zoom;

  if (!zoom) {
    state.loop = null;
  } else {
    // the loop is exactly the selection, whether it narrowed or widened
    state.loop = { startTime: zoom.start, duration: zoom.end - zoom.start };
    if (position != null && position >= zoom.start && position <= zoom.end) {
      // keep playing from the same place, re-anchored at this commit
      state.offset = position;
      state.startTime = at;
    } else {
      state.desiredPlaySpeed = 1;
      state.isBufferingVideo = true;
      state.offset = zoom.start;
      state.startTime = at;
    }
  }
  return state;
}

// Everything the signed-in session can see. Cleared when it ends; the URL
// (navigation) is not private and stays.
function clearPrivateState(state) {
  Object.keys(eventsMap).forEach((key) => delete eventsMap[key]);
  Object.keys(locationMap).forEach((key) => delete locationMap[key]);
  return {
    ...state,
    sessionEpoch: (state.sessionEpoch || 0) + 1,
    profile: null,
    entities: { ...state.entities, devices: {}, deviceOrder: null },
    subscription: null,
    subscribeInfo: null,
    primeStripeResult: null,
    files: null,
    filesUploading: {},
    filesUploadingMeta: { dongleId: null, fetchedAt: null },
    uploadQueues: {},
    routes: null,
    routesMeta: { dongleId: null, start: null, end: null },
    lastRoutes: null,
    currentRoute: null,
    missingRoute: null,
    limit: 0,
  };
}

// The selected route once its metadata is known: zoom and loop from the
// URL's selection, intersected with the route.
function adoptCurrentRoute(state) {
  const drive = state.nav?.location?.base.drive;
  if (state.currentRoute || !drive) return state;
  const curr = state.routes?.find((route) => route.log_id === drive.logId);
  if (!curr) return state;
  state.currentRoute = { ...curr };
  const zoom = effectiveZoom(drive, state.currentRoute);
  if (!zoom) {
    state.zoom = null;
    state.loop = null;
  } else if (!state.zoom || state.zoom.end !== zoom.end) {
    state.zoom = zoom;
    state.loop = null;
  }
  if (state.zoom && (!state.loop || !state.loop.startTime || !state.loop.duration)) {
    state.loop = { startTime: state.zoom.start, duration: state.zoom.end - state.zoom.start };
  }
  return state;
}

// A route asset fetched for an older version of the route (fewer qlogs).
function staleRouteVersion(state, action) {
  if (action.maxqlog === undefined) return false;
  const route = state.routes?.find((r) => r.fullname === action.fullname)
    || (state.currentRoute?.fullname === action.fullname ? state.currentRoute : null);
  return Boolean(route && route.maxqlog !== action.maxqlog);
}

export default function reducer(_state, action) {
  // results of async work started in an earlier session carry its epoch
  if (action.epoch !== undefined && action.epoch !== _state.sessionEpoch) {
    return _state;
  }
  let state = { ..._state };
  switch (action.type) {
    case Types.ACTION_STARTUP_DATA:
      state = setDeviceList(state, action.devices, action.fetchedAt);
      state.profile = action.profile;
      break;
    case Types.NAVIGATION_COMMITTED: {
      const { location, previous, generation, at } = action;
      state.nav = { location, generation };
      // pages without a device (referrals, root, invalid) keep the last one
      const dongleId = location.base.dongleId ?? state.dongleId;
      if (dongleId && dongleId !== state.dongleId) {
        state = applySelectedDevice(state, dongleId);
      }
      state = applySelectedDrive(state, previous?.base, location.base, at);
      break;
    }
    case Types.ACTION_SESSION_ENDED:
      state = clearPrivateState(state);
      break;
    case Types.ACTION_PAIR_REQUESTED:
      state.pairRequests = (state.pairRequests || 0) + 1;
      break;
    case Types.ACTION_SELECT_TIME_FILTER:
      state = {
        ...state,
        lastRoutes: state.routes,
        filter: {
          start: action.start,
          end: action.end,
        },
        routesMeta: {
          dongleId: null,
          start: null,
          end: null,
        },
        routes: null,
        currentRoute: null,
      };
      break;
    case Types.ACTION_UPDATE_ROUTE_LIMIT:
      state = {
        ...state,
        limit: action.limit,
      };
      break;
    case Types.ACTION_UPDATE_DEVICES:
      state = setDeviceList(state, action.devices, action.fetchedAt);
      break;
    case Types.ACTION_UPDATE_DEVICE: {
      // e.g. a rename: merge (keeping rpc, network_metered); a device the
      // list doesn't have yet joins it
      const { dongle_id: dongleId } = action.device;
      state = updateDeviceEntity(state, dongleId, (previous) => ({ ...previous, ...action.device, fetched_at: action.fetchedAt }));
      const order = state.entities.deviceOrder;
      if (order && !order.includes(dongleId)) {
        state = withDevices(state, state.entities.devices, [dongleId, ...order]);
      }
      break;
    }
    case Types.ACTION_UPDATE_ROUTE:
      if (staleRouteVersion(state, action)) break;
      if (state.routes) {
        state.routes = state.routes.map((route) => {
          if (route.fullname === action.fullname) {
            return {
              ...route,
              ...action.route,
            };
          }
          return route;
        });
      }
      if (state.currentRoute && state.currentRoute.fullname === action.fullname) {
        state.currentRoute = {
          ...state.currentRoute,
          ...action.route,
        };
      }
      break;
    case Types.ACTION_UPDATE_ROUTE_EVENTS: {
      if (staleRouteVersion(state, action)) break;
      const firstFrame = action.events.find((ev) => ev.type === 'event' && ev.data.event_type === 'first_road_camera_frame');
      const videoStartOffset = firstFrame ? firstFrame.route_offset_millis : null;
      eventsMap[action.fullname] = {
        events: action.events,
        videoStartOffset,
      }
      if (state.routes) {
        state.routes = state.routes.map((route) => {
          const ev = eventsMap[route.fullname];
          if (ev) {
            return {
              ...route,
              events: ev.events,
              videoStartOffset: ev.videoStartOffset,
            };
          }
          return route;
        });
      }
      if (state.currentRoute && state.currentRoute.fullname === action.fullname) {
        state.currentRoute = {
          ...state.currentRoute,
          events: action.events,
          videoStartOffset,
        };
      }
      break;
    }
    case Types.ACTION_UPDATE_ROUTE_LOCATION: {
      locationMap[action.fullname] = {
        location: action.location,
        locationKey: action.locationKey,
      }
      if (state.routes) {
        state.routes = state.routes.map((route) => {
          const loc = locationMap[route.fullname];
          if (loc) {
            return {
              ...route,
              [loc.locationKey]: loc.location,
            };
          }
          return route;
        });
      }
      if (state.currentRoute && state.currentRoute.fullname === action.fullname) {
        state.currentRoute = {
          ...state.currentRoute,
        };
        state.currentRoute[action.locationKey] = action.location;
      }
      break;
    }
    case Types.ACTION_UPDATE_SHARED_DEVICE:
      // a device the account doesn't list (shared with the user)
      state = updateDeviceEntity(state, action.dongleId, () => ({ ...action.device, fetched_at: action.fetchedAt }));
      break;
    case Types.ACTION_UPDATE_DEVICE_ONLINE:
      state = updateDeviceEntity(state, action.dongleId, (previous) => ({
        ...previous, last_athena_ping: action.last_athena_ping, fetched_at: action.fetched_at,
      }));
      break;
    case Types.ACTION_UPDATE_DEVICE_NETWORK:
      state = updateDeviceEntity(state, action.dongleId, (previous) => ({ ...previous, network_metered: action.networkMetered }));
      break;
    case Types.ACTION_UPDATE_DEVICE_RPC:
      // merge RPC-fetched values (e.g. not_car) into the device's `rpc` field
      state = updateDeviceEntity(state, action.dongleId, (previous) => ({
        ...previous, rpc: { ...previous.rpc, ...action.fields },
      }));
      break;
    case Types.ACTION_PRIME_SUBSCRIPTION:
      if (action.dongleId !== state.dongleId) { // ignore outdated info
        break;
      }
      state = {
        ...state,
        subscription: action.subscription,
        subscribeInfo: null,
      };
      break;
    case Types.ACTION_PRIME_STRIPE_RESULT:
      if (action.dongleId !== state.dongleId) {
        break;
      }
      state.primeStripeResult = { success: action.success, cancelled: action.cancelled };
      break;
    case Types.ACTION_PRIME_SUBSCRIBE_INFO:
      if (action.dongleId !== state.dongleId) {
        break;
      }
      state = {
        ...state,
        subscribeInfo: action.subscribeInfo,
        subscription: null,
      };
      break;
    case Types.ACTION_FILES_URLS:
      if (action.dongleId !== state.dongleId) break; // late result for another device
      state.files = {
        ...(state.files !== null ? { ...state.files } : {}),
        ...action.urls,
      };
      break;
    case Types.ACTION_FILES_UPDATE:
      if (action.dongleId !== state.dongleId) break;
      state.files = {
        ...(state.files !== null ? { ...state.files } : {}),
        ...action.files,
      };
      break;
    case Types.ACTION_FILES_UPLOADING:
      // every polled device keeps its own queue (an upload panel can show
      // another device's); the selected device's also drives its files
      state.uploadQueues = { ...state.uploadQueues, [action.dongleId]: { uploading: action.uploading, fetchedAt: action.fetchedAt } };
      if (action.dongleId !== state.dongleId) break;
      state.filesUploading = action.uploading;
      state.filesUploadingMeta = {
        dongleId: action.dongleId,
        fetchedAt: action.fetchedAt,
      };
      if (Object.keys(action.files).length) {
        state.files = {
          ...(state.files !== null ? { ...state.files } : {}),
          ...action.files,
        };
      }
      break;
    case Types.ACTION_FILES_CANCELLED_UPLOADS: {
      const queue = state.uploadQueues?.[action.dongleId];
      if (queue) {
        const uploading = Object.fromEntries(Object.entries(queue.uploading).filter(([id]) => !action.ids.includes(id)));
        state.uploadQueues = { ...state.uploadQueues, [action.dongleId]: { ...queue, uploading } };
      }
      if (action.dongleId !== state.dongleId) break;
      if (state.files) {
        const cancelFileNames = Object.keys(state.filesUploading)
          .filter((id) => action.ids.includes(id))
          .map((id) => state.filesUploading[id].fileName);
        state.files = Object.keys(state.files)
          .filter((fileName) => !cancelFileNames.includes(fileName))
          .reduce((obj, fileName) => { obj[fileName] = state.files[fileName]; return obj; }, {});
      }
      state.filesUploading = Object.keys(state.filesUploading)
        .filter((id) => !action.ids.includes(id))
        .reduce((obj, id) => { obj[id] = state.filesUploading[id]; return obj; }, {});
      break;
    }
    case Types.ACTION_ROUTES_METADATA: {
      // merge existing routes' event and location info with new routes
      state.routes = action.routes.map((route) => {
        const existingRoute = state.lastRoutes ?
          state.lastRoutes.find((r) => r.fullname === route.fullname) : {};
        return {
          ...existingRoute,
          ...route,
        }
      });
      state.routesMeta = {
        dongleId: action.dongleId,
        start: action.start,
        end: action.end,
      };
      state = adoptCurrentRoute(state);
      break;
    }
    case Types.ACTION_ROUTE_DETAIL:
      // a drive not in the loaded list: add it without replacing the list
      if (action.dongleId !== state.dongleId) break;
      state.routes = (state.routes || []).some((route) => route.fullname === action.route.fullname)
        ? state.routes
        : [...(state.routes || []), action.route];
      state = adoptCurrentRoute(state);
      break;
    case Types.ACTION_ROUTE_DETAIL_MISSING:
      if (action.dongleId !== state.dongleId) break;
      state.missingRoute = `${action.dongleId}|${action.logId}`;
      break;
    default:
      return state;
  }

  return state;
}
