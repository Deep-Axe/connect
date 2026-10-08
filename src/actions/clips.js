import { createClipService } from '../api/clips';
import { fallbackServices } from '../routing/services';

// One transfer/support owner per store/session. The replacement service waits
// for the preceding session's physical cache clear before reading or writing.
export function getClipService() {
  return (_dispatch, getState, services = fallbackServices) => {
    if (!services.clips) {
      const epoch = getState().sessionEpoch;
      services.clips = createClipService({
        ready: services.clipClearPromise,
        isCurrent: () => getState().sessionEpoch === epoch,
      });
    }
    return services.clips;
  };
}

export function clearClipService(services) {
  // Clear persisted bytes even if this store has not used clips since reload.
  const service = services.clips ?? createClipService({ ready: services.clipClearPromise });
  services.clips = null;
  services.clipClearPromise = service.clear();
  return services.clipClearPromise;
}
