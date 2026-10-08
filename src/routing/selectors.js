import { VIEWS } from './codec';

export const selectNavLocation = (state) => state.nav?.location ?? null;

export const selectView = (state) => selectNavLocation(state)?.base.view ?? null;

export const selectSelectedRouteId = (state) => selectNavLocation(state)?.base.drive?.logId ?? null;

export const selectIsPrimeView = (state) => selectView(state) === VIEWS.PRIME;

export const selectIsStreamView = (state) => selectView(state) === VIEWS.STREAM;

export const selectIsReferralsView = (state) => selectView(state) === VIEWS.REFERRALS;
