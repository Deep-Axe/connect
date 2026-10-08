import * as Sentry from '@sentry/react';
import { athena as Athena } from '../api';
import { api } from '../api/backend';

import { updateDeviceOnline, fetchDeviceNetworkStatus, invalidateRoutes } from '.';
import * as Types from './types';
import { deviceOnCellular, getDeviceFromState, deviceVersionAtLeast, asyncSleep } from '../utils';
import { ownedDispatch } from './owned';
import { selectDevice, selectDeviceById } from '../selectors';
import { fallbackServices } from '../routing/services';
import { runResourceRequest, invalidateResourceRequest } from '../resources/requests';
import { selectFilesQuery } from '../resources/selectors';
import { fileInventoryExpiry } from '../resources/freshness';

export const FILE_NAMES = {
  qcameras: ['qcamera.ts'],
  cameras: ['fcamera.hevc'],
  dcameras: ['dcamera.hevc'],
  ecameras: ['ecamera.hevc'],
  qlogs: ['qlog.bz2', 'qlog.zst'],
  logs: ['rlog.bz2', 'rlog.zst'],
};
const MAX_OPEN_REQUESTS = 15;
const MAX_RETRIES = 5;

// connect uploads should be high priority as they are user requested (lower is higher)
const HIGH_PRIORITY = 0;

let openRequests = 0;

function pathToFileName(dongleId, path) {
  const [seg, fileType] = path.split('/');
  const type = Object.entries(FILE_NAMES).find((e) => e[1].includes(fileType))[0];
  return `${dongleId}|${seg}/${type}`;
}

async function athenaCall(dongleId, payload, sentryFingerprint, isCurrent = () => true, retryCount = 0) {
  try {
    if (!isCurrent()) return null;
    while (openRequests >= MAX_OPEN_REQUESTS) {
      // eslint-disable-next-line no-await-in-loop
      await asyncSleep(2000);
      if (!isCurrent()) return null;
    }
    openRequests += 1;
    try {
      return await Athena.postJsonRpcPayload(dongleId, payload);
    } finally {
      // Release exactly the slot acquired, including failed network requests.
      openRequests -= 1;
    }
  } catch (err) {
    if (!err.resp && retryCount < MAX_RETRIES) {
      await asyncSleep(2000);
      return athenaCall(dongleId, payload, sentryFingerprint, isCurrent, retryCount + 1);
    }
    if (err.message?.includes('Timed out') || err.message?.includes('Device not registered')) {
      return { offline: true };
    }
    console.error(err);
    Sentry.captureException(err, { fingerprint: sentryFingerprint });
    return { error: err.message };
  }
}

export function setRouteViewed(dongleId, route) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const device = selectDevice(getState());
    if (!deviceVersionAtLeast(device, '0.9.6')) {
      return;
    }

    const payload = {
      id: 0,
      jsonrpc: '2.0',
      method: 'setRouteViewed',
      params: { route },
    };
    await athenaCall(dongleId, payload, 'action_files_set_route_viewed', dispatch.isCurrent);
  };
}

export async function fetchUploadUrls(dongleId, paths) {
  try {
    const resp = await api.routes.getUploadUrls(dongleId, paths, 7);
    if (resp && !resp.error) {
      return resp.map((r) => r.url);
    }
  } catch (err) {
    console.error(err);
    Sentry.captureException(err, { fingerprint: 'action_files_upload_geturls' });
  }
  return null;
}

// `dongleId`: the device the files belong to. Async work passes the device it
// was started for; only interactive callers default to the selected one.
export function updateFiles(files, dongleId = null) {
  return (dispatch, getState) => {
    dongleId = dongleId ?? getState().dongleId;
    dispatch({
      type: Types.ACTION_FILES_UPDATE,
      dongleId,
      files,
    });
  };
}

export function invalidateFiles(fullname) {
  return (dispatch, getState, services = fallbackServices) => {
    const epoch = getState().sessionEpoch;
    invalidateResourceRequest(services, epoch, `files|${fullname}`);
    dispatch({ type: Types.ACTION_INVALIDATE_FILES, fullname, epoch });
  };
}

export function fetchFiles(routeName, nocache = false) {
  return (dispatch, getState, services = fallbackServices) => {
    const query = selectFilesQuery(getState(), routeName);
    const metadataVersion = getState().entities?.routes?.[routeName]?.maxqlog;
    if (!nocache && query?.status === 'loaded' && query.expiresAt > Date.now() && query.metadataVersion === metadataVersion) {
      return Promise.resolve(query);
    }
    return runResourceRequest(services, getState, `files|${routeName}|${metadataVersion ?? 'unknown'}`,
      () => api.routes.getRouteFiles(routeName, nocache),
      (files, { epoch, requestId }) => {
        if (getState().entities?.routes?.[routeName]?.maxqlog !== metadataVersion) return;
        if (!files || typeof files !== 'object') throw new Error('Missing route file inventory');
        const urlName = routeName.replace('|', '/');
        const urls = Object.keys(FILE_NAMES)
          .filter((type) => Array.isArray(files[type]))
          .flatMap((type) => files[type].map((url) => [type, url]))
          .reduce((result, [type, url]) => {
            const path = new URL(url).pathname;
            const segment = path.split(urlName)[1]?.split('/')[1];
            if (!/^\d+$/.test(segment ?? '')) throw new Error('Invalid route file segment');
            result[`${routeName}--${Number(segment)}/${type}`] = { url };
            return result;
          }, {});
        const fetchedAt = Date.now();
        dispatch({
          type: Types.ACTION_FILES_URLS, dongleId: routeName.split('|')[0], fullname: routeName,
          urls, epoch, requestId, fetchedAt, expiresAt: fileInventoryExpiry(files, fetchedAt), metadataVersion,
        });
      }, nocache, `files|${routeName}`).catch((err) => {
      console.error(err);
      Sentry.captureException(err, { fingerprint: 'action_files_fetch_files' });
      return null;
    });
  };
}

// Upload queue polls, per store and per device (services.uploads.targets):
// `inFlight` while a request is out, `timer` for the next poll, `owners`
// (an open queue, a drive's download menu) that want it. Stopping clears the
// timer and bumps `run`, so a request already out doesn't schedule another.
// Each device has its own poll, so B's queue can load over A's drive while
// A's menu keeps polling A.
function uploadTarget(services, dongleId) {
  let target = services.uploads.targets.get(dongleId);
  if (!target) {
    target = { inFlight: false, timer: null, run: 0, owners: new Set() };
    services.uploads.targets.set(dongleId, target);
  }
  return target;
}

function stopUploadTarget(target) {
  if (target.timer) clearTimeout(target.timer);
  target.timer = null;
  target.run += 1;
  target.inFlight = false;
  target.request = null;
}

export function stopAllUploadQueuePolls(services) {
  services.uploads.targets.forEach(stopUploadTarget);
}

export function pollUploadQueue(owner, dongleId) {
  return (dispatch, getState, services = fallbackServices) => {
    // A mounted consumer can move between devices. Its previous target no
    // longer owns that consumer, while other consumers keep their poll.
    services.uploads.targets.forEach((target, previousId) => {
      if (previousId !== dongleId && target.owners.delete(owner) && target.owners.size === 0) {
        stopUploadTarget(target);
      }
    });
    uploadTarget(services, dongleId).owners.add(owner);
    dispatch(fetchUploadQueue(dongleId));
  };
}

export function stopPollingUploadQueue(owner) {
  return (dispatch, getState, services = fallbackServices) => {
    services.uploads.targets.forEach((target) => {
      if (target.owners.delete(owner) && target.owners.size === 0) stopUploadTarget(target);
    });
  };
}

export function uploadQueuePollers(dongleId = null) {
  return (dispatch, getState, services = fallbackServices) => {
    if (dongleId) return services.uploads.targets.get(dongleId)?.owners.size ?? 0;
    let count = 0;
    services.uploads.targets.forEach((target) => { count += target.owners.size; });
    return count;
  };
}

export function cancelFetchUploadQueue() {
  return (dispatch, getState, services = fallbackServices) => stopAllUploadQueuePolls(services);
}

export function fetchUploadQueue(dongleId) {
  return async (rawDispatch, getState, services = fallbackServices) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const target = uploadTarget(services, dongleId);
    if (target.inFlight || target.timer) {
      return;
    }
    target.inFlight = true;
    const request = {};
    target.request = request;
    const { run } = target;
    const epoch = getState().sessionEpoch;
    try {
      await pollUploadQueueOnce(dongleId, dispatch, getState, target, () => (
        getState().sessionEpoch === epoch && target.run === run
      ));
    } finally {
      if (target.request === request) {
        target.inFlight = false;
        target.request = null;
      }
    }
  };
}

async function pollUploadQueueOnce(dongleId, dispatch, getState, target, stillWanted) {
  dispatch(fetchDeviceNetworkStatus(dongleId));

  const payload = {
    method: 'listUploadQueue',
    jsonrpc: '2.0',
    id: 0,
  };
  const uploadQueue = await athenaCall(dongleId, payload, 'action_files_athena_uploadqueue', stillWanted);
  // the session ended or polling stopped meanwhile: touch nothing
  if (!stillWanted()) return;
  if (!uploadQueue || !Array.isArray(uploadQueue.result)) {
    if (uploadQueue && uploadQueue.offline) {
      dispatch(updateDeviceOnline(dongleId, 0));
    }
    return;
  }
  dispatch(updateDeviceOnline(dongleId, Math.floor(Date.now() / 1000)));

  // this device's previous snapshot, copied
  const prevFilesUploading = { ...getState().uploadQueues?.[dongleId]?.uploading };
  const device = getDeviceFromState(getState(), dongleId);
  const uploadingFiles = {};
  const newCurrentUploading = {};
  for (const uploading of uploadQueue.result) {
    const urlParts = uploading.url.split('?')[0].split('/');
    const filename = urlParts[urlParts.length - 1];
    const segNum = urlParts[urlParts.length - 2];
    const datetime = urlParts[urlParts.length - 3];
    const dongle = urlParts[urlParts.length - 4];
    const type = Object.entries(FILE_NAMES).find((entry) => entry[1].includes(filename))?.[0];
    if (!type) continue;
    const fileName = `${dongle}|${datetime}--${segNum}/${type}`;
    const waitingWifi = Boolean(deviceOnCellular(device) && uploading.allow_cellular === false);
    uploadingFiles[fileName] = {
      current: uploading.current,
      progress: uploading.progress,
      paused: waitingWifi,
    };
    newCurrentUploading[uploading.id] = {
      fileName,
      current: uploading.current,
      progress: uploading.progress,
      createdAt: uploading.created_at,
      paused: waitingWifi,
    };
    delete prevFilesUploading[uploading.id];
  }
  // some item is done uploading
  if (Object.keys(prevFilesUploading).length) {
    const completedRoutes = new Set(Object.values(prevFilesUploading).map(upload => upload.fileName.split('--').slice(0, 2).join('--')));
    for (const routeName of completedRoutes) {
      dispatch(invalidateFiles(routeName));
      dispatch(invalidateRoutes(routeName));
      if (getState().dongleId === dongleId) dispatch(fetchFiles(routeName, true));
    }
  }
  dispatch({
    type: Types.ACTION_FILES_UPLOADING,
    dongleId,
    uploading: newCurrentUploading,
    files: uploadingFiles,
    fetchedAt: Date.now(),
  });
  // keep polling while something is uploading and someone is watching this
  // device (an open queue or menu, or it is the selected device)
  const watched = () => target.owners.size > 0 || getState().dongleId === dongleId;
  if (uploadQueue.result.length && watched()) {
    target.timer = setTimeout(() => {
      target.timer = null;
      if (watched()) dispatch(fetchUploadQueue(dongleId));
    }, 2000);
  }
}

export function doUpload(dongleId, paths, urls) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const device = selectDeviceById(getState(), dongleId);
    let loopedUploads = !deviceVersionAtLeast(device, '0.8.13');
    if (!loopedUploads) {
      const filesData = paths.map((path, i) => ({
        fn: path,
        url: urls[i],
        headers: { 'x-ms-blob-type': 'BlockBlob' },
        allow_cellular: false,
        priority: HIGH_PRIORITY,
      }));
      const payload = {
        id: 0,
        jsonrpc: '2.0',
        method: 'uploadFilesToUrls',
        params: { files_data: filesData },
        expiry: Math.floor(Date.now() / 1000) + (86400 * 7),
      };
      const resp = await athenaCall(dongleId, payload, 'action_files_athena_uploads', dispatch.isCurrent);
      if (!dispatch.isCurrent()) return;
      if (resp && resp.error && resp.error.code === -32000
        && resp.error.data.message === 'too many values to unpack (expected 3)') {
        loopedUploads = true;
      } else if (!resp || resp.error) {
        const newUploading = paths.reduce((state, path) => {
          state[pathToFileName(dongleId, path)] = {};
          return state;
        }, {});
        dispatch(updateDeviceOnline(dongleId, Math.floor(Date.now() / 1000)));
        dispatch(updateFiles(newUploading, dongleId));
      } else if (resp.offline) {
        dispatch(updateDeviceOnline(dongleId, 0));
      } else if (resp.result === 'Device offline, message queued') {
        const newUploading = paths.reduce((state, path) => {
          state[pathToFileName(dongleId, path)] = { progress: 0, current: false };
          return state;
        }, {});
        dispatch(updateFiles(newUploading, dongleId));
      } else if (resp.result) {
        let failed = resp.result.failed || [];

        // only if all file names for a segment file type failed
        let failedFiltered = [];
        for (const f of failed) {
          let failedCnt = failed.filter((p) => pathToFileName(dongleId, p) === pathToFileName(dongleId, f)).length;
          let requestedCnt = paths.filter((p) => pathToFileName(dongleId, p) === pathToFileName(dongleId, f)).length;
          if (failedCnt >= requestedCnt) {
            failedFiltered.push(f);
          }
        }

        if (failedFiltered) {
          const uploading = failedFiltered
            .reduce((state, path) => {
              const fn = pathToFileName(dongleId, path);
              state[fn] = { notFound: true };
              return state;
            }, {});
          dispatch(updateFiles(uploading, dongleId));
        }
        dispatch(fetchUploadQueue(dongleId));
      }
    }

    if (loopedUploads) {
      for (let i = 0; i < paths.length; i++) {
        if (!dispatch.isCurrent()) return;
        const payload = {
          id: 0,
          jsonrpc: '2.0',
          method: 'uploadFileToUrl',
          params: [paths[i], urls[i], { 'x-ms-blob-type': 'BlockBlob' }],
          expiry: Math.floor(Date.now() / 1000) + (86400 * 7),
        };
        // eslint-disable-next-line no-await-in-loop
        const resp = await athenaCall(dongleId, payload, 'files_actions_athena_upload', dispatch.isCurrent);
        if (!dispatch.isCurrent()) return;
        if (!resp || resp.error) {
          const uploading = {};
          uploading[pathToFileName(dongleId, paths[i])] = {};
          dispatch(updateDeviceOnline(dongleId, Math.floor(Date.now() / 1000)));
          dispatch(updateFiles(uploading, dongleId));
        } else if (resp.offline) {
          dispatch(updateDeviceOnline(dongleId, 0));
        } else if (resp.result === 'Device offline, message queued') {
          const uploading = {};
          uploading[pathToFileName(dongleId, paths[i])] = { progress: 0, current: false };
          dispatch(updateFiles(uploading, dongleId));
        } else if (resp.result === 404 || resp?.result?.failed?.[0] === paths[i]) {
          const uploading = {};
          uploading[pathToFileName(dongleId, paths[i])] = { notFound: true };
          dispatch(updateFiles(uploading, dongleId));
        } else if (resp.result) {
          dispatch(fetchUploadQueue(dongleId));
        }
      }
    }
  };
}

export function fetchAthenaQueue(dongleId) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    let queue;
    try {
      queue = await api.devices.getAthenaQueue(dongleId);
    } catch (err) {
      console.error(err);
      Sentry.captureException(err, { fingerprint: 'action_files_fetch_athena_queue' });
      return;
    }

    const newUploading = {};
    for (const q of queue) {
      if (!q.method || !q.expiry || q.expiry < Math.floor(Date.now() / 1000)) {
        continue;
      }

      if (q.method === 'uploadFileToUrl') {
        const fileName = pathToFileName(dongleId, q.params[0]);
        newUploading[fileName] = { progress: 0, current: false };
      } else if (q.method === 'uploadFilesToUrls') {
        for (const { fn } of q.params.files_data) {
          const fileName = pathToFileName(dongleId, fn);
          newUploading[fileName] = { progress: 0, current: false };
        }
      }
    }
    dispatch(updateFiles(newUploading, dongleId));
  };
}

export function cancelUploads(dongleId, ids) {
  return async (rawDispatch, getState) => {
    const dispatch = ownedDispatch(rawDispatch, getState);
    const payload = {
      id: 0,
      jsonrpc: '2.0',
      method: 'cancelUpload',
      params: { upload_id: ids },
    };
    const resp = await athenaCall(dongleId, payload, 'action_files_athena_canceluploads', dispatch.isCurrent);
    if (resp && resp.result && resp.result.success) {
      const idsArray = Array.isArray(ids) ? ids : [ids];
      dispatch({
        type: Types.ACTION_FILES_CANCELLED_UPLOADS,
        dongleId,
        ids: idsArray,
      });
    } else if (resp && resp.offline) {
      dispatch(updateDeviceOnline(dongleId, 0));
    }
  };
}
