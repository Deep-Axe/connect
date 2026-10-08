import { reduceResources } from '../resources/reducer';
import { pruneRouteLists } from '../resources/pruneRoutes';
import * as Types from '../actions/types';
import { emptyDevice } from '../utils/emptyDevice';
import { getDefaultFilter } from '../utils/filter';
import { offsetAt } from '../timeline/offset';
import { LIMIT_INCREMENT, selectCurrentRoute } from '../selectors';

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
  const listed = new Set(list.map((device) => device.dongle_id));
  for (const id of state.entities.deviceOrder ?? []) {
    if (!listed.has(id)) devices[id] = { ...devices[id], is_owner: false, shared: true };
  }
  list.forEach((device) => {
    const previous = devices[device.dongle_id];
    devices[device.dongle_id] = {
      ...previous,
      ...device,
      shared: Boolean(device.shared),
      ...((previous?.rpc || device.rpc) ? { rpc: { ...previous?.rpc, ...device.rpc } } : {}),
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

function applySelectedDevice(state, dongleId, at) {
  return {
    ...state,
    dongleId,
    // a device keeps its own list preferences; the first visit starts them
    lists: state.lists[dongleId]
      ? state.lists
      : { ...state.lists, [dongleId]: { filter: getDefaultFilter(at), limit: LIMIT_INCREMENT } },
    // Stripe result feedback belongs to the selected device.
    primeStripeResult: null,
  };
}

// ---- routes: stored once, by fullname (entities.routes); what was loaded
// is recorded per query (queries.routeLists / routeDetails)

function withRoutes(state, routes) {
  return { ...state, entities: { ...state.entities, routes } };
}

// Merge route payloads into their entities, keeping what the payload doesn't
// carry (events, locations, drive coordinates).
function mergeRoutes(routes, payloads, requestId = 0, fetchedAt = 0, details = {}) {
  const merged = { ...routes };
  payloads.forEach((route) => {
    const previous = merged[route.fullname];
    if (Math.max(previous?.metadataRequestId ?? 0, details[route.fullname]?.requestId ?? 0) > requestId) return;
    const kept = { ...previous };
    if (previous && previous.maxqlog !== route.maxqlog) {
      for (const field of ['events', 'videoStartOffset', 'driveCoords', 'eventsVersion', 'driveCoordsVersion']) delete kept[field];
    }
    if (previous && (previous.start_lat !== route.start_lat || previous.start_lng !== route.start_lng)) delete kept.startLocation;
    if (previous && (previous.end_lat !== route.end_lat || previous.end_lng !== route.end_lng)) delete kept.endLocation;
    merged[route.fullname] = { ...kept, ...route, metadataRequestId: requestId, metadataFetchedAt: fetchedAt };
  });
  return merged;
}

function updateRouteEntity(state, fullname, update) {
  const route = state.entities.routes[fullname];
  return route ? withRoutes(state, { ...state.entities.routes, [fullname]: update(route) }) : state;
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
  const oldName = previousBase?.drive ? `${previousBase.dongleId}|${previousBase.drive.logId}` : null;
  const nextName = drive ? `${base.dongleId}|${drive.logId}` : null;
  if (oldName && oldName !== nextName && state.offset != null) {
    const remembered = { ...state.runtime.routes };
    delete remembered[oldName];
    remembered[oldName] = { offset: offsetAt(state, at), speed: state.desiredPlaySpeed };
    while (Object.keys(remembered).length > 20) delete remembered[Object.keys(remembered)[0]];
    state.runtime = { ...state.runtime, routes: remembered };
  }

  if (!drive) {
    state.zoom = null;
    state.loop = null;
    return state;
  }

  const sameDrive = previousDrive?.logId === drive.logId;
  if (sameDrive && previousDrive.start === drive.start && previousDrive.end === drive.end && state.zoom) {
    return state;
  }

  const currentRoute = state.entities.routes[`${base.dongleId}|${drive.logId}`] ?? null;
  const zoom = effectiveZoom(drive, currentRoute);

  // where playback actually is right now (offset is only an anchor: playing
  // advances from it since startTime), under the old selection
  const remembered = !sameDrive ? state.runtime.routes[nextName] : null;
  const position = sameDrive && state.offset != null ? offsetAt(state, at) : remembered?.offset ?? null;
  state.zoom = zoom;

  if (!zoom) {
    state.loop = null;
    if (!sameDrive) { state.offset = null; state.isBufferingVideo = true; }
  } else {
    // the loop is exactly the selection, whether it narrowed or widened
    state.loop = { startTime: zoom.start, duration: zoom.end - zoom.start };
    if (position != null && position >= zoom.start && position <= zoom.end) {
      // keep playing from the same place, re-anchored at this commit
      state.offset = position;
      state.startTime = at;
      if (remembered) { state.desiredPlaySpeed = remembered.speed; state.isBufferingVideo = true; }
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
  return {
    ...state,
    sessionEpoch: (state.sessionEpoch || 0) + 1,
    profile: null,
    entities: { devices: {}, deviceOrder: null, routes: {}, files: {} },
    queries: { routeLists: {}, routeDetails: {}, subscriptions: {}, files: {} },
    lists: {},
    runtime: { routes: {} },
    zoom: null, loop: null, offset: null, desiredPlaySpeed: 0, isBufferingVideo: true,
    primeStripeResult: null,
    uploadQueues: {},
  };
}

// The selected drive's route just became known (from a list or a detail):
// take zoom and loop from the URL's selection, intersected with the route.
function adoptCurrentRoute(state, previousRoute, at) {
  const drive = state.nav?.location?.base.drive;
  const route = selectCurrentRoute(state);
  if (!drive || !route || (previousRoute && previousRoute.duration === route.duration)) return state;
  const zoom = effectiveZoom(drive, route);
  if (!zoom) { state.zoom = null; state.loop = null; }
  else {
    const position = state.offset == null ? null : offsetAt(state, at);
    state.zoom = zoom;
    state.loop = { startTime: zoom.start, duration: zoom.end - zoom.start };
    state.offset = position == null ? zoom.start : Math.max(zoom.start, Math.min(position, zoom.end));
    state.startTime = at;
  }
  return state;
}

// A route asset fetched for an older version of the route (fewer qlogs).
function staleRouteVersion(state, action) {
  if (action.maxqlog === undefined) return false;
  const route = state.entities.routes[action.fullname];
  return Boolean(route && route.maxqlog !== action.maxqlog);
}

export default function reducer(_state, action) {
  // results of async work started in an earlier session carry its epoch
  if (action.epoch !== undefined && action.epoch !== _state.sessionEpoch) {
    return _state;
  }
  const resourceState = reduceResources(_state, action);
  if (resourceState) return resourceState;
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
        state = applySelectedDevice(state, dongleId, at);
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
      // a new filter is a new list (and starts from the first page)
      state.lists = { ...state.lists, [action.dongleId]: { filter: { start: action.start, end: action.end }, limit: LIMIT_INCREMENT } };
      break;
    case Types.ACTION_UPDATE_ROUTE_LIMIT:
      // "load more": a new list key for the larger page
      state.lists = { ...state.lists, [action.dongleId]: { ...state.lists[action.dongleId], limit: action.limit } };
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
      state = updateRouteEntity(state, action.fullname, (route) => ({ ...route, ...action.route }));
      break;
    case Types.ACTION_UPDATE_ROUTE_EVENTS: {
      if (staleRouteVersion(state, action)) break;
      const firstFrame = action.events.find((ev) => ev.type === 'event' && ev.data.event_type === 'first_road_camera_frame');
      const videoStartOffset = firstFrame ? firstFrame.route_offset_millis : null;
      state = updateRouteEntity(state, action.fullname, (route) => ({ ...route, events: action.events, eventsVersion: action.maxqlog, videoStartOffset }));
      break;
    }
    case Types.ACTION_UPDATE_ROUTE_LOCATION:
      state = updateRouteEntity(state, action.fullname, (route) => ({ ...route, [action.locationKey]: action.location }));
      break;
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
    case Types.ACTION_PRIME_STRIPE_RESULT:
      if (action.dongleId !== state.dongleId) {
        break;
      }
      state.primeStripeResult = { success: action.success, cancelled: action.cancelled };
      break;
    case Types.ACTION_ROUTE_LIST_LOADED: {
      // one list query's answer: written to its own key, never selecting
      const previousRoute = selectCurrentRoute(state);
      state = withRoutes(state, mergeRoutes(state.entities.routes, action.routes, action.requestId, action.fetchedAt, state.queries.routeDetails));
      const details = { ...state.queries.routeDetails };
      for (const route of action.routes) {
        const entity = state.entities.routes[route.fullname];
        if (details[route.fullname]?.status === 'missing' && entity && entity.metadataRequestId === action.requestId) {
          details[route.fullname] = { status: 'loaded', fetchedAt: action.fetchedAt, requestId: action.requestId };
        }
      }
      state.queries = {
        ...state.queries,
        routeDetails: details,
        routeLists: {
          ...state.queries.routeLists,
          [action.key]: {
            dongleId: action.dongleId,
            start: action.start,
            end: action.end,
            limit: action.limit,
            status: 'loaded',
            fullnames: action.routes.map((route) => route.fullname),
            fetchedAt: action.fetchedAt,
          },
        },
      };
      state = adoptCurrentRoute(state, previousRoute, action.fetchedAt);
      state = pruneRouteLists(state);
      break;
    }
    case Types.ACTION_ROUTE_DETAIL_LOADED: {
      // one drive's answer: its route, or that it doesn't exist
      const previousRoute = selectCurrentRoute(state);
      const existing = state.entities.routes[action.fullname];
      const previousDetail = state.queries.routeDetails[action.fullname];
      if (Math.max(existing?.metadataRequestId ?? 0, previousDetail?.requestId ?? 0) > action.requestId) break;
      if (!action.route) {
        const routes = { ...state.entities.routes };
        delete routes[action.fullname];
        state = withRoutes(state, routes);
      }
      if (action.route) state = withRoutes(state, mergeRoutes(state.entities.routes, [action.route], action.requestId, action.fetchedAt, state.queries.routeDetails));
      state.queries = {
        ...state.queries,
        routeDetails: {
          ...state.queries.routeDetails,
          [action.fullname]: { status: action.route ? 'loaded' : 'missing', fetchedAt: action.fetchedAt, requestId: action.requestId },
        },
      };
      state = adoptCurrentRoute(state, previousRoute, action.fetchedAt);
      break;
    }
    default:
      return state;
  }

  return state;
}
