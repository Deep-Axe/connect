import { expect, it } from 'vitest';
import { createInitialState } from '../initialState';
import { createRoutingServices } from '../routing/services';
import globalState from '../reducers/globalState';
import { invalidateRoutes, updateRoute } from '../actions';

it('mutations invalidate all affected lists, exact details and pending request owners', () => {
  let state = createInitialState();
  const fullname = 'aaaaaaaaaaaaaaaa|2026-08-06--12-00-00';
  const other = 'bbbbbbbbbbbbbbbb|2026-08-06--12-00-00';
  state.entities.routes[fullname] = { fullname, metadataFetchedAt: 100, is_public: false };
  state.queries.routeDetails = { [fullname]: { fetchedAt: 100 }, [other]: { fetchedAt: 100 } };
  state.queries.routeLists = { a: { dongleId: fullname.split('|')[0], fetchedAt: 100 }, b: { dongleId: other.split('|')[0], fetchedAt: 100 } };
  const services = createRoutingServices();
  const keys = [`list|0|${fullname.split('|')[0]}|1|2|50`, `detail|0|${fullname}`, `detail|0|${other}`];
  keys.forEach(key => { services.requests.routeLatest.set(key, 1); services.requests.routeQueries.set(key, Promise.resolve()); });
  const dispatch = action => typeof action === 'function' ? action(dispatch, () => state, services) : (state = globalState(state, action));
  dispatch(updateRoute(fullname, { is_public: true }));
  expect(state.entities.routes[fullname].is_public).toBe(true);
  expect(state.entities.routes[fullname].metadataFetchedAt).toBe(0);
  expect(state.queries.routeLists.a.fetchedAt).toBe(0);
  expect(state.queries.routeLists.b.fetchedAt).toBe(100);
  expect(state.queries.routeDetails[fullname].fetchedAt).toBe(0);
  expect(state.queries.routeDetails[other].fetchedAt).toBe(100);
  expect([...services.requests.routeLatest.keys()]).toEqual([keys[2]]);
  dispatch(invalidateRoutes(fullname));
  expect(state.queries.routeLists.a.fetchedAt).toBe(0);
});
