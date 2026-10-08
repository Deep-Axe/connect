import { selectRouteListKey } from '../selectors';

export const MAX_ROUTE_LISTS = 20;

export function pruneRouteLists(state, maximum = MAX_ROUTE_LISTS) {
  const listEntries = Object.entries(state.queries.routeLists);
  let routeLists = state.queries.routeLists;
  if (listEntries.length > maximum) {
    const active = selectRouteListKey(state);
    // Preserve the visible list first, then the most recently fetched lists.
    listEntries.sort(
      ([keyA, a], [keyB, b]) => Number(keyB === active) - Number(keyA === active) || b.fetchedAt - a.fetchedAt,
    );
    routeLists = Object.fromEntries(listEntries.slice(0, maximum));
  }

  const referenced = new Set();
  Object.values(routeLists).forEach((query) => query.fullnames?.forEach((fullname) => referenced.add(fullname)));
  const base = state.nav.location?.base;
  const activeDrive = base?.drive ? `${base.dongleId}|${base.drive.logId}` : null;
  if (activeDrive) referenced.add(activeDrive);

  // Direct drive links never create a list. Cap those detail records too,
  // always keeping the open drive and any drive still named by a kept list.
  const detailEntries = Object.entries(state.queries.routeDetails);
  let routeDetails = state.queries.routeDetails;
  if (detailEntries.length > maximum) {
    detailEntries.sort(([, a], [, b]) => (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0));
    const kept = [];
    detailEntries.forEach((entry) => {
      if (referenced.has(entry[0]) || kept.length < maximum) kept.push(entry);
    });
    routeDetails = Object.fromEntries(kept);
  }
  Object.keys(routeDetails).forEach((fullname) => referenced.add(fullname));

  const orphanRoute = Object.keys(state.entities.routes).some((fullname) => !referenced.has(fullname));
  if (routeLists === state.queries.routeLists && routeDetails === state.queries.routeDetails && !orphanRoute) {
    return state;
  }
  const routes = Object.fromEntries(
    Object.entries(state.entities.routes).filter(([fullname]) => referenced.has(fullname)),
  );
  return { ...state, queries: { ...state.queries, routeLists, routeDetails }, entities: { ...state.entities, routes } };
}
