export function invalidateRouteQueries(state, fullname, dongleId = fullname?.split('|')[0]) {
  const routeLists = Object.fromEntries(
    Object.entries(state.queries.routeLists).map(([key, query]) => [
      key,
      query.dongleId === dongleId ? { ...query, fetchedAt: 0 } : query,
    ]),
  );
  const routeDetails = { ...state.queries.routeDetails };
  if (fullname && routeDetails[fullname]) routeDetails[fullname] = { ...routeDetails[fullname], fetchedAt: 0 };
  const routes = { ...state.entities.routes };
  if (fullname && routes[fullname]) routes[fullname] = { ...routes[fullname], metadataFetchedAt: 0 };
  return { ...state, queries: { ...state.queries, routeLists, routeDetails }, entities: { ...state.entities, routes } };
}
