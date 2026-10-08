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
import { activeBackendType, selectBackendType } from '../api/backend';
import { hardNavigate } from '../utils/navigation';
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

    // demo and real data never share a page load: crossing over reloads
    const backendType = activeBackendType();
    if (backendType && selectBackendType(routerLocation.pathname) !== backendType) {
      hardNavigate(urlOfRouterLocation(routerLocation));
      return result;
    }

    services.history.observe(routerLocation, historyAction);

    const location = parseLocation(routerLocation);
    const canonical = buildUrl(location);
    // a non-canonical entry deferred its effects to the next location on the
    // same page: its own rewrite, or a newer one that superseded it
    const pending = services.navigation.pendingCanonical;
    const resumed = Boolean(pending && sameBase(pending.location, location));
    const samePage = !resumed && sameBase(previous, location) && Object.keys(location.commands).length === 0;
    // Two counters, two questions:
    //  - generation: is this still the same page? Advanced only when the page
    //    changes; guards loads and redirects (a query/hash-only change, such
    //    as consuming a command, keeps them valid).
    //  - revision: is this still the exact location? Advanced on every
    //    commit; guards rewrites of the URL itself.
    if (!samePage) services.navigation.generation += 1;
    services.navigation.revision += 1;
    const { generation, revision } = services.navigation;
    store.dispatch({ type: NAVIGATION_COMMITTED, location, previous, generation, at: Date.now() });

    if (canonical && canonical !== urlOfRouterLocation(routerLocation)) {
      // trailing slash, aliases (/demo), non-canonical numbers: rewrite the
      // URL first and run effects once, for the canonical location, against
      // the state from before this non-canonical entry
      services.navigation.pendingCanonical = resumed ? pending : { location, previous, previousDongleId };
      afterRender(() => {
        // any newer location, even on the same page, wins over this rewrite
        if (services.navigation.revision === revision) store.dispatch(replace(canonical));
      });
      return result;
    }

    services.navigation.pendingCanonical = null;
    if (resumed) {
      ({ previous, previousDongleId } = pending);
    }

    if (samePage) {
      return result; // query/hash-only change: nothing to load
    }

    const ctx = createEffectContext(store, services, generation, revision, previousDongleId);
    afterRender(() => runNavigationEffects(previous, location, ctx));
    return result;
  };
}
