// Read access to the keyed state. Data is stored once, by key (entities and
// queries); what a page shows (the selected device, its drives, ...) is
// derived here from the URL's selection. Selectors are memoized on their
// inputs, so an unrelated state change returns the same object and
// connected components don't re-render.

import { emptyDevice } from './utils/emptyDevice';

// Keep results for immutable inputs even when stores or selections alternate.
// Object branches are weak so the memoizer does not retain discarded state.
export function memoize(fn) {
  const node = () => ({ objects: new WeakMap(), values: new Map(), hasResult: false });
  const root = node();
  return (...args) => {
    let current = root;
    for (const arg of args) {
      const children =
        arg !== null && (typeof arg === 'object' || typeof arg === 'function') ? current.objects : current.values;
      if (!children.has(arg)) children.set(arg, node());
      current = children.get(arg);
    }
    if (!current.hasResult) {
      current.result = fn(...args);
      current.hasResult = true;
    }
    return current.result;
  };
}

// ---- devices

const devicesInOrder = memoize((order, byId) => (order ? order.map((id) => byId[id]).filter(Boolean) : null));

// The account's devices, sorted; null until the list has loaded.
export const selectDevices = (state) => devicesInOrder(state.entities.deviceOrder, state.entities.devices);

const placeholders = {};
function placeholderFor(dongleId) {
  if (!placeholders[dongleId]) placeholders[dongleId] = { ...emptyDevice, dongle_id: dongleId };
  return placeholders[dongleId];
}

// A device by id: a listed or fetched one, or (once the account list has
// loaded) a placeholder for a shared/public device not fetched yet.
export function selectDeviceById(state, dongleId) {
  if (!dongleId) return null;
  const device = state.entities.devices[dongleId];
  if (device) return device;
  return state.entities.deviceOrder ? placeholderFor(dongleId) : null;
}

// The selected device (from the URL).
export const selectDevice = (state) => selectDeviceById(state, state.dongleId);

// ---- routes: entities.routes by fullname; list queries by
// `${dongleId}|${start}|${end}|${limit}`; detail queries by fullname; each
// device's list preferences (filter, limit) in `lists`.

export const LIMIT_INCREMENT = 5;

export function routeListKey(dongleId, filter, limit) {
  return `${dongleId}|${filter.start}|${filter.end}|${limit}`;
}

// The selected device's list preferences (set when the device is first
// selected; see the reducer).
export const selectListPrefs = (state) => (state.dongleId ? (state.lists[state.dongleId] ?? null) : null);
export const selectFilter = (state) => selectListPrefs(state)?.filter ?? null;
export const selectLimit = (state) => selectListPrefs(state)?.limit ?? LIMIT_INCREMENT;

export function selectRouteListKey(state) {
  const prefs = selectListPrefs(state);
  return prefs ? routeListKey(state.dongleId, prefs.filter, prefs.limit) : null;
}

// Memoize by query identity and referenced entities, including inactive lists.
const routeArrays = new WeakMap();
function routesOf(list, routes) {
  if (!list) return null;
  const next = list.fullnames.map((name) => routes[name]).filter(Boolean);
  const previous = routeArrays.get(list);
  if (previous && previous.length === next.length && next.every((route, i) => route === previous[i])) return previous;
  routeArrays.set(list, next);
  return next;
}
export const selectRoutes = (state) =>
  routesOf(state.queries.routeLists[selectRouteListKey(state)], state.entities.routes);

const latestListOf = memoize((lists, dongleId) =>
  Object.values(lists)
    .filter((list) => list.dongleId === dongleId)
    .reduce((latest, list) => (!latest || list.fetchedAt > latest.fetchedAt ? list : latest), null),
);

// What the drive list shows: the current list, or while it loads the most
// recently loaded list for this device (replaces the old lastRoutes copy).
export function selectRoutesForDisplay(state) {
  const current = selectRoutes(state);
  if (current) return current;
  return routesOf(latestListOf(state.queries.routeLists, state.dongleId), state.entities.routes);
}

export function selectedRouteFullname(state) {
  const base = state.nav?.location?.base;
  return base?.drive && base.dongleId ? `${base.dongleId}|${base.drive.logId}` : null;
}

// The selected drive's route (from the URL), once its metadata is known.
export const selectCurrentRoute = (state) => state.entities?.routes?.[selectedRouteFullname(state)] ?? null;

export const selectRouteDetail = (state, fullname) => state.queries.routeDetails[fullname] ?? null;

// The selected drive was looked up and does not exist.
export const selectSelectedRouteMissing = (state) => {
  const fullname = selectedRouteFullname(state);
  return Boolean(fullname && selectRouteDetail(state, fullname)?.status === 'missing');
};
