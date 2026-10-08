// Destination helpers: the only code that writes browser history. They
// never touch navigation state directly; the routing middleware applies the
// resulting location like any other.

import { goBack, push, replace } from 'connected-react-router';

import {
  VIEWS,
  buildUrl,
  deviceBase,
  directBaseFor,
  driveBase,
  locationFor,
  locationForEdit,
  locationOfUrl,
  modalAllowedOn,
  parentModal,
  parseLocation,
  referralsBase,
  rootBase,
  sameBase,
  urlOfRouterLocation,
} from './codec';
import { selectNavLocation } from './selectors';
import { fallbackServices } from './services';

// Navigate to a complete location. A push records its parent entry so a
// later "back" can be verified (see services.createHistoryTracker).
// `interactive` marks an entry opened by a user action in this session.
export function navigateToLocation(location, { replace: replaceEntry = false, interactive = false } = {}) {
  return (dispatch, getState) => {
    const url = buildUrl(location);
    const current = getState().router.location;
    if (!url || url === urlOfRouterLocation(current)) return;
    if (replaceEntry) {
      dispatch(replace(url));
    } else {
      dispatch(
        push(url, {
          parent: { key: current.key ?? null, url: urlOfRouterLocation(current) },
          ...(interactive ? { interactive: true } : {}),
        }),
      );
    }
  };
}

export function navigate(base, options) {
  return (dispatch, getState) =>
    dispatch(navigateToLocation(locationForEdit(base, selectNavLocation(getState())), options));
}

export const toRoot = () => navigate(rootBase());
export const toDashboard = (dongleId) => navigate(dongleId ? deviceBase(VIEWS.DASHBOARD, dongleId) : rootBase());
export const toPrime = (dongleId) => navigate(deviceBase(VIEWS.PRIME, dongleId));
export const toStream = (dongleId) => navigate(deviceBase(VIEWS.STREAM, dongleId));
export const toReferrals = () => navigate(referralsBase());
export const toDrive = (dongleId, logId) => navigate(driveBase(dongleId, logId));

// Canonical drive bounds for a millisecond selection: rounded outward to
// whole seconds exactly once, here. Returns null for an invalid selection.
export function quantizeRange(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return null;
  const start = Math.floor(startMs / 1000) * 1000;
  const end = Math.ceil(endMs / 1000) * 1000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  return { start, end };
}

export function toDriveRange(dongleId, logId, startMs, endMs) {
  return (dispatch) => {
    const range = quantizeRange(startMs, endMs);
    if (!range) return;
    dispatch(navigate(driveBase(dongleId, logId, range.start, range.end)));
  };
}

// Return to the verified parent entry when `accepts(parentBase)` holds,
// otherwise navigate to `fallback`.
function backOr(accepts, fallback, options) {
  return (dispatch, getState, services = fallbackServices) => {
    const current = getState().router.location;
    const parentUrl = services.history.verifiedParentUrl(current);
    if (parentUrl && accepts(parseLocation(locationOfUrl(parentUrl)).base)) {
      dispatch(goBack());
      return;
    }
    dispatch(navigate(fallback, options));
  };
}

const anyParent = () => true;

// leave a full-page task (Prime, stream, referrals) for where the user came from
export const leavePage = (dongleId) => backOr(anyParent, dongleId ? deviceBase(VIEWS.DASHBOARD, dongleId) : rootBase());

// drive back arrow: return to a verified wider selection of the same drive,
// otherwise replace the current selection with the whole drive
export function driveBack() {
  return (dispatch, getState) => {
    const base = selectNavLocation(getState())?.base;
    if (base?.view !== VIEWS.DRIVE || base.drive.start == null) return;
    const { dongleId, drive } = base;
    const wider = (parent) =>
      parent.view === VIEWS.DRIVE
      && parent.dongleId === dongleId
      && parent.drive.logId === drive.logId
      && (parent.drive.start == null || (parent.drive.start <= drive.start && parent.drive.end >= drive.end));
    dispatch(backOr(wider, driveBase(dongleId, drive.logId), { replace: true }));
  };
}

// Open a task dialog over the current page. The page (including its drive
// range), unknown query arguments and hash are kept.
// From a page that can't host it (a legacy link still resolving, not found,
// stream) the dialog opens on its own direct link instead.
export function openModal(modal, { replace: replaceEntry = false } = {}) {
  return (dispatch, getState) => {
    const current = selectNavLocation(getState());
    if (!current) return;
    const target = modalAllowedOn(current.base, modal)
      ? { ...current, commands: {}, modal }
      : { ...locationFor(directBaseFor(modal), current), modal };
    dispatch(navigateToLocation(target, { replace: replaceEntry, interactive: true }));
  };
}

// Close the current dialog (or its nested panel/preview) to its parent: back
// to the verified entry it was opened from when that is the same page,
// otherwise replace with the deterministic parent from the URL alone.
export function closeModal() {
  return (dispatch, getState, services = fallbackServices) => {
    const current = selectNavLocation(getState());
    if (!current?.modal) return;
    const parent = { ...current, commands: {}, modal: parentModal(current.modal) };
    const parentUrl = services.history.verifiedParentUrl(getState().router.location);
    if (parentUrl && sameBase(parseLocation(locationOfUrl(parentUrl)), current)) {
      dispatch(goBack());
      return;
    }
    dispatch(navigateToLocation(parent, { replace: true }));
  };
}

// True when the current entry was opened by a user action in this session
// (not a direct link, refresh or history jump to an unobserved entry).
// Dispatch it to get the answer (it needs the store's history tracker).
export function openedInteractively() {
  return (dispatch, getState, services = fallbackServices) => {
    const { location, action } = getState().router;
    // a push in this session; Back/Forward onto the entry is not a click
    return Boolean(action === 'PUSH' && location.state?.interactive && services.history.verifiedParentUrl(location));
  };
}
