import * as Types from '../actions/types';
import { invalidateRouteQueries } from './invalidateRoutes';

function withQueries(state, name, key, query) {
  return { ...state, queries: { ...state.queries, [name]: { ...state.queries?.[name], [key]: query } } };
}

function mergeFiles(state, files) {
  return { ...state, entities: { ...state.entities, files: { ...state.entities.files, ...files } } };
}

// Returns null for actions owned by the navigation/device/route reducer.
export function reduceResources(state, action) {
  switch (action.type) {
    case Types.ACTION_INVALIDATE_ROUTES:
      return invalidateRouteQueries(state, action.fullname, action.dongleId);
    case Types.ACTION_PRIME_SUBSCRIPTION:
    case Types.ACTION_PRIME_SUBSCRIBE_INFO: {
      const current = state.queries?.subscriptions?.[action.dongleId];
      if (action.requestId != null && current?.requestId > action.requestId) return state;
      return withQueries(state, 'subscriptions', action.dongleId, {
        subscription: action.subscription ?? null,
        subscribeInfo: action.subscribeInfo ?? null,
        fetchedAt: action.fetchedAt ?? 0,
        kind: action.kind ?? (action.type === Types.ACTION_PRIME_SUBSCRIPTION ? 'subscription' : 'subscribeInfo'),
        requestId: action.requestId ?? current?.requestId,
      });
    }
    case Types.ACTION_INVALIDATE_SUBSCRIPTION: {
      const query = state.queries?.subscriptions?.[action.dongleId];
      return query ? withQueries(state, 'subscriptions', action.dongleId, { ...query, fetchedAt: 0 }) : state;
    }
    case Types.ACTION_FILES_URLS: {
      const query = state.queries?.files?.[action.fullname];
      if (action.requestId != null && query?.requestId > action.requestId) return state;
      const files = { ...state.entities.files };
      for (const name of query?.fileNames ?? []) {
        if (!(name in action.urls)) delete files[name];
      }
      Object.assign(files, action.urls);
      const next = { ...state, entities: { ...state.entities, files } };
      return withQueries(next, 'files', action.fullname, {
        status: 'loaded',
        fetchedAt: action.fetchedAt,
        expiresAt: action.expiresAt,
        fileNames: Object.keys(action.urls),
        requestId: action.requestId,
        metadataVersion: action.metadataVersion,
      });
    }
    case Types.ACTION_INVALIDATE_FILES: {
      const query = state.queries?.files?.[action.fullname];
      return query ? withQueries(state, 'files', action.fullname, { ...query, status: 'stale', expiresAt: 0 }) : state;
    }
    case Types.ACTION_FILES_UPDATE:
      return mergeFiles(state, action.files);
    case Types.ACTION_FILES_UPLOADING:
      return {
        ...mergeFiles(state, action.files),
        uploadQueues: {
          ...state.uploadQueues,
          [action.dongleId]: { uploading: action.uploading, fetchedAt: action.fetchedAt },
        },
      };
    case Types.ACTION_FILES_CANCELLED_UPLOADS: {
      const queue = state.uploadQueues?.[action.dongleId];
      if (!queue) return state;
      const removed = Object.entries(queue.uploading).filter(([id]) => action.ids.includes(id));
      const uploading = Object.fromEntries(Object.entries(queue.uploading).filter(([id]) => !action.ids.includes(id)));
      const files = { ...state.entities.files };
      for (const [, item] of removed) {
        const file = files[item.fileName];
        if (!file) continue;
        const rest = { ...file };
        delete rest.current;
        delete rest.progress;
        delete rest.paused;
        if (Object.keys(rest).length) files[item.fileName] = rest;
        else delete files[item.fileName];
      }
      return {
        ...state,
        entities: { ...state.entities, files },
        uploadQueues: { ...state.uploadQueues, [action.dongleId]: { ...queue, uploading } },
      };
    }
    default:
      return null;
  }
}
