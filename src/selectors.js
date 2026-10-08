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
      const children = arg !== null && (typeof arg === 'object' || typeof arg === 'function')
        ? current.objects : current.values;
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
