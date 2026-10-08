
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
    offset: null,           // milliseconds from the beginning of the drive
    startTime: Date.now(),  // millisecond timestamp in which play began

    profile: null,

    // data, stored once by key; pages derive what they show (src/selectors.js)
    entities: {
      devices: {},          // by dongle id: the account's and shared devices
      deviceOrder: null,    // the account's devices, sorted; null until loaded
      files: {},
      routes: {},           // by fullname, with events/locations/coords
    },
    queries: {
      subscriptions: {}, files: {},
      routeLists: {},       // by `${dongleId}|${start}|${end}|${limit}`
      routeDetails: {},     // by fullname: 'loaded' | 'missing'
    },
    runtime: { routes: {} }, // bounded remembered playback, by fullname
    lists: {},              // per device: { filter, limit }

    primeStripeResult: null,
    pairRequests: 0,      // bumped when a pair token arrives by URL

    uploadQueues: {},

    zoom: null,
    loop: null,
  };
}

export default createInitialState();
