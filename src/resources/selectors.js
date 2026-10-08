import { memoize } from '../selectors';

const EMPTY_UPLOADS = Object.freeze({});

export function selectedFullname(state) {
  const base = state.nav?.location?.base;
  return base?.dongleId && base.drive?.logId ? `${base.dongleId}|${base.drive.logId}` : null;
}

export const selectSubscriptionQuery = (state, dongleId = state.dongleId) =>
  state.queries?.subscriptions?.[dongleId] ?? null;
export const selectSubscription = (state, dongleId = state.dongleId) =>
  selectSubscriptionQuery(state, dongleId)?.subscription ?? null;
export const selectSubscribeInfo = (state, dongleId = state.dongleId) =>
  selectSubscriptionQuery(state, dongleId)?.subscribeInfo ?? null;
export const selectFilesQuery = (state, fullname = selectedFullname(state)) => state.queries?.files?.[fullname] ?? null;
export const selectFilesUploading = (state, dongleId = state.dongleId) =>
  state.uploadQueues?.[dongleId]?.uploading ?? EMPTY_UPLOADS;

const filesForRoute = memoize((files, fullname, fresh, known) => {
  if (!fullname) return null;
  const prefix = `${fullname}--`;
  const entries = Object.entries(files ?? {}).filter(([name]) => name.startsWith(prefix));
  if (!entries.length) return known ? {} : null;
  return Object.fromEntries(
    entries.map(([name, file]) => [name, fresh || !file.url ? file : { ...file, url: undefined }]),
  );
});

// Expired signed URLs never remain actionable while the inventory refreshes.
export function selectFiles(state, fullname = selectedFullname(state), now = Date.now()) {
  const query = selectFilesQuery(state, fullname);
  const fresh = Boolean(
    query
      && query.status === 'loaded'
      && query.expiresAt > now
      && query.metadataVersion === state.entities?.routes?.[fullname]?.maxqlog,
  );
  return filesForRoute(state.entities?.files, fullname, fresh, Boolean(query));
}
