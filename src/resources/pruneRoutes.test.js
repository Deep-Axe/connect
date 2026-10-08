import { expect, it } from 'vitest';
import { createInitialState } from '../initialState';
import { pruneRouteLists } from './pruneRoutes';
import { routeListKey } from '../selectors';

it('caps lists at twenty while retaining active, detail and overlapping entity references', () => {
  const state = createInitialState();
  state.dongleId = 'a';
  state.lists.a = { filter: { start: 0, end: 1 }, limit: 10 };
  const active = routeListKey('a', state.lists.a.filter, 10);
  state.queries.routeLists[active] = { fullnames: ['active'], fetchedAt: 0 };
  state.entities.routes.active = { fullname: 'active' };
  state.entities.routes.detail = { fullname: 'detail' };
  state.queries.routeDetails.detail = { status: 'loaded' };
  for (let i = 1; i <= 21; i += 1) {
    state.queries.routeLists[`q${i}`] = { fullnames: [`route${i}`, 'shared'], fetchedAt: i };
    state.entities.routes[`route${i}`] = { fullname: `route${i}` };
  }
  state.entities.routes.shared = { fullname: 'shared' };
  const pruned = pruneRouteLists(state);
  expect(Object.keys(pruned.queries.routeLists)).toHaveLength(20);
  expect(pruned.queries.routeLists[active]).toBeDefined();
  expect(pruned.entities.routes.detail).toBeDefined();
  expect(pruned.entities.routes.shared).toBeDefined();
  expect(pruned.entities.routes.route1).toBeUndefined();
  expect(pruned.entities.routes.route2).toBeUndefined();
  expect(pruneRouteLists(pruned)).toBe(pruned);
});
