import localforage from 'localforage';

import { fallbackServices } from './services';

// One small persistence barrier per store: a token write, read, conditional
// removal and logout cleanup cannot pass each other while storage yields.
function serialize(services, operation) {
  const previous = services.commands.pairStorageTail ?? Promise.resolve();
  const pending = previous.then(operation);
  services.commands.pairStorageTail = pending.catch(() => undefined);
  return pending;
}

export function storePairToken(token, isWanted = () => true) {
  return (_dispatch, getState, services = fallbackServices) => {
    const epoch = getState().sessionEpoch;
    const revision = (services.commands.pairStorageRevision ?? 0) + 1;
    services.commands.pairStorageRevision = revision;
    const current = () =>
      getState().sessionEpoch === epoch && services.commands.pairStorageRevision === revision && isWanted();
    return serialize(services, async () => {
      if (!current()) return false;
      await localforage.setItem('pairToken', token);
      if (current()) return true;
      // Successor writes are behind this operation. Remove only our token,
      // including when the current session ended during the storage await.
      if ((await localforage.getItem('pairToken')) === token) await localforage.removeItem('pairToken');
      return false;
    });
  };
}

export function readPairToken() {
  return (_dispatch, getState, services = fallbackServices) => {
    const epoch = getState().sessionEpoch;
    return serialize(services, () => (getState().sessionEpoch === epoch ? localforage.getItem('pairToken') : null));
  };
}

export function removePairToken(token) {
  return (_dispatch, getState, services = fallbackServices) => {
    const epoch = getState().sessionEpoch;
    return serialize(services, async () => {
      if (!token || getState().sessionEpoch !== epoch) return false;
      const stored = await localforage.getItem('pairToken');
      if (getState().sessionEpoch !== epoch || stored !== token) return false;
      await localforage.removeItem('pairToken');
      return true;
    });
  };
}

export function clearPairToken(services) {
  services.commands.pairStorageRevision = (services.commands.pairStorageRevision ?? 0) + 1;
  return serialize(services, () => localforage.removeItem('pairToken'));
}
