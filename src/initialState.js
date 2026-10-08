import { getDefaultFilter } from './utils/filter';

// Environment-independent: navigation state is filled in by the routing
// middleware from the router's first location, never from window.location.
export function createInitialState() {
  return {
    nav: {
      location: null,   // parsed URL, written only by NAVIGATION_COMMITTED
      generation: 0,
    },
    dongleId: null,     // selected device, mirrors the last URL that named one
    sessionEpoch: 0,    // bumped when the signed-in session ends

    desiredPlaySpeed: 1,    // speed set by user
    isBufferingVideo: true, // if we're currently buffering for more data
    offset: null,           // in miliseconds, relative to state.zoom.start
    startTime: Date.now(),  // millisecond timestamp in which play began

    routes: null,
    routesMeta: {
      dongleId: null,
      start: null,
      end: null,
    },
    currentRoute: null,
    lastRoutes: null,

    profile: null,

    // data, stored once by key; pages derive what they show (src/selectors.js)
    entities: {
      devices: {},          // by dongle id: the account's and shared devices
      deviceOrder: null,    // the account's devices, sorted; null until loaded
    },

    subscription: null,
    subscribeInfo: null,
    primeStripeResult: null,
    pairRequests: 0,      // bumped when a pair token arrives by URL
    missingRoute: null,   // 'dongle|log' a detail request found no route for

    files: null,
    filesUploading: {},   // the selected device's upload queue
    uploadQueues: {},     // every polled device's upload queue, by dongle id
    filesUploadingMeta: {
      dongleId: null,
      fetchedAt: null,
    },

    filter: getDefaultFilter(),
    zoom: null,
    loop: null,
    limit: 0,
  };
}

export default createInitialState();
