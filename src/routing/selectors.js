import { selectCurrentRoute, selectSelectedRouteMissing as selectedRouteMissing } from '../selectors';
import { VIEWS } from './codec';

export const selectNavLocation = (state) => state.nav?.location ?? null;

export const selectView = (state) => selectNavLocation(state)?.base.view ?? null;

export const selectSelectedRouteId = (state) => selectNavLocation(state)?.base.drive?.logId ?? null;

export const selectIsPrimeView = (state) => selectView(state) === VIEWS.PRIME;

export const selectIsStreamView = (state) => selectView(state) === VIEWS.STREAM;

// The URL names a range that starts after the drive ends.
export const selectSelectionOutOfRange = (state) => {
  const drive = selectNavLocation(state)?.base.drive;
  return Boolean(
    drive && drive.start != null && selectCurrentRoute(state) && drive.start >= selectCurrentRoute(state).duration,
  );
};

// The selected drive was looked up and does not exist.
export const selectSelectedRouteMissing = selectedRouteMissing;

export const selectIsReferralsView = (state) => selectView(state) === VIEWS.REFERRALS;
