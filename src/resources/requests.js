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

export function invalidateResourceRequest(services, epoch, ownerKey) {
  const requests = resourceRequests(services);
  const identity = `${epoch}|${ownerKey}`;
  const owner = requests.latest.get(identity);
  requests.latest.delete(identity);
  for (const [key, request] of requests.pending) {
    if (request === owner) requests.pending.delete(key);
  }
}

export function runResourceRequest(services, getState, key, load, commit, force = false, ownerKey = key) {
  const requests = resourceRequests(services);
  const epoch = getState().sessionEpoch;
  const identity = `${epoch}|${key}`;
  // Different endpoint variants can answer one canonical query record. They
  // share an owner, never a promise (e.g. subscription vs subscribe info).
  const ownerIdentity = `${epoch}|${ownerKey}`;
  const pending = requests.pending.get(identity);
  if (pending && !force && requests.latest.get(ownerIdentity) === pending) return pending.promise;

  requests.sequence += 1;
  const request = { sequence: requests.sequence };
  requests.latest.set(ownerIdentity, request);
  requests.pending.set(identity, request);
  const isCurrent = () => getState().sessionEpoch === epoch && requests.latest.get(ownerIdentity) === request;
  request.promise = Promise.resolve().then(() => isCurrent() ? load() : null).then((value) => {
    if (isCurrent()) commit(value, { epoch, requestId: request.sequence, isCurrent });
    return isCurrent() ? value : null;
  }).finally(() => {
    if (requests.pending.get(identity) === request) requests.pending.delete(identity);
    if (requests.latest.get(ownerIdentity) === request) requests.latest.delete(ownerIdentity);
  });
  return request.promise;
}
