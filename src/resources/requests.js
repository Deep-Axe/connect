// One request owner per exact query within a store/session. Forced refreshes
// supersede existing work; an obsolete promise never releases its successor.
export function createResourceRequests() {
  return { pending: new Map(), latest: new Map(), sequence: 0 };
}

export function resourceRequests(services) {
  services.resources ??= createResourceRequests();
  return services.resources;
}

export function clearResourceRequests(services) {
  const requests = resourceRequests(services);
  requests.pending.clear();
  requests.latest.clear();
}

export function runResourceRequest(services, getState, key, load, commit, force = false) {
  const requests = resourceRequests(services);
  const epoch = getState().sessionEpoch;
  const identity = `${epoch}|${key}`;
  const pending = requests.pending.get(identity);
  if (pending && !force) return pending.promise;

  requests.sequence += 1;
  const request = { sequence: requests.sequence };
  requests.latest.set(identity, request);
  requests.pending.set(identity, request);
  const isCurrent = () => getState().sessionEpoch === epoch && requests.latest.get(identity) === request;
  request.promise = Promise.resolve().then(() => isCurrent() ? load() : null).then((value) => {
    if (isCurrent()) commit(value, { epoch, requestId: request.sequence, isCurrent });
    return isCurrent() ? value : null;
  }).finally(() => {
    if (requests.pending.get(identity) === request) requests.pending.delete(identity);
    if (requests.latest.get(identity) === request) requests.latest.delete(identity);
  });
  return request.promise;
}
