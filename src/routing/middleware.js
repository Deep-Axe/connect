// The single URL → state path. Every router location (the initial one,
// PUSH, POP and REPLACE) goes through here exactly once:
//
//   LOCATION_CHANGE → router reducer → parseLocation → canonical? →
//   NAVIGATION_COMMITTED (pure reducers) → runNavigationEffects (async work)
//
// The commit is synchronous because ConnectedRouter dispatches the initial
// location while rendering; effects run after the current render.

import { LOCATION_CHANGE, replace } from 'connected-react-router';

import { NAVIGATION_COMMITTED } from '../actions/types';
import { buildUrl, parseLocation, sameBase, urlOfRouterLocation } from './codec';
import { createEffectContext, runNavigationEffects } from './effects';

const afterRender = (fn) => Promise.resolve().then(fn);

export function createRoutingMiddleware(services) {
  return (store) => (next) => (action) => {
    if (!action) {
      return undefined;
    }
    if (action.type !== LOCATION_CHANGE) {
      return next(action);
    }

    let previous = store.getState().nav?.location ?? null;
    let previousDongleId = store.getState().dongleId;
    const result = next(action);

    const { location: routerLocation, action: historyAction } = action.payload;
    services.history.observe(routerLocation, historyAction);

    const location = parseLocation(routerLocation);
    const pendingUrl = services.navigation.pendingCanonical?.url;
    const samePage = sameBase(previous, location) && Object.keys(location.commands).length === 0
      && pendingUrl !== buildUrl(location);
    // a query/hash-only change on the same page (e.g. consuming a command) is
    // not a new navigation: in-flight redirects for this page stay valid
    if (!samePage) services.navigation.generation += 1;
    const { generation } = services.navigation;
    store.dispatch({
      type: NAVIGATION_COMMITTED,
      location,
      previous,
      generation,
      at: Date.now(),
    });

    const canonical = buildUrl(location);
    if (canonical && canonical !== urlOfRouterLocation(routerLocation)) {
      // trailing slash, aliases (/demo), non-canonical numbers: rewrite the
      // URL first and run effects once, for the canonical location, against
      // the state from before this non-canonical entry
      services.navigation.pendingCanonical = services.navigation.pendingCanonical
        ?? { url: canonical, previous, previousDongleId };
      afterRender(() => store.dispatch(replace(canonical)));
      return result;
    }

    const pending = services.navigation.pendingCanonical;
    services.navigation.pendingCanonical = null;
    const resumed = pending?.url === canonical;
    if (resumed) {
      ({ previous, previousDongleId } = pending);
    }

    const commandsPresent = Object.keys(location.commands).length > 0;
    if (!resumed && sameBase(previous, location) && !commandsPresent) {
      return result; // query/hash-only change: nothing to load
    }

    const ctx = createEffectContext(store, services, generation, previousDongleId);
    afterRender(() => runNavigationEffects(previous, location, ctx));
    return result;
  };
}
