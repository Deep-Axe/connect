import { selectRouteListKey } from '../selectors';

export const MAX_ROUTE_LISTS = 20;

export function pruneRouteLists(state, maximum = MAX_ROUTE_LISTS) {
  const entries = Object.entries(state.queries.routeLists);
  if (entries.length <= maximum) return state;
  const active = selectRouteListKey(state);
  // Preserve the visible list first, then the most recently fetched lists.
  entries.sort(([keyA, a], [keyB, b]) => (
    Number(keyB === active) - Number(keyA === active) || b.fetchedAt - a.fetchedAt
  ));
  const routeLists = Object.fromEntries(entries.slice(0, maximum));
  const referenced = new Set(Object.keys(state.queries.routeDetails));
  Object.values(routeLists).forEach(query => query.fullnames.forEach(fullname => referenced.add(fullname)));
  const base = state.nav.location?.base;
  if (base?.drive) referenced.add(`${base.dongleId}|${base.drive.logId}`);
  const routes = Object.fromEntries(Object.entries(state.entities.routes).filter(([fullname]) => referenced.has(fullname)));
  return {
    ...state,
    queries: { ...state.queries, routeLists },
    entities: { ...state.entities, routes },
  };
}
