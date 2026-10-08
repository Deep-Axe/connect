// A session lease authorizes both continuations and reducer writes. Nested
// thunks retain the initiating lease instead of acquiring the current session.
export function ownedDispatch(dispatch, getState) {
  const epoch = getState().sessionEpoch;
  const isCurrent = () => getState().sessionEpoch === epoch;
  const owned = (action) => {
    if (!isCurrent()) return undefined;
    return typeof action === 'function'
      ? dispatch((_dispatch, ...rest) => (isCurrent() ? action(owned, ...rest) : undefined))
      : dispatch({ ...action, epoch });
  };
  owned.isCurrent = isCurrent;
  return owned;
}

// Capture at interaction time, before the first prerequisite. Resources may
// outlive a query/modal edit; task-directed effects can also require the exact
// location. A component's own mount/attempt guard remains its responsibility.
export function captureOperation({ resource = () => true, location = false } = {}) {
  return (dispatch, getState) => {
    const epoch = getState().sessionEpoch;
    const initialLocation = getState().nav?.location;
    const isCurrent = () =>
      getState().sessionEpoch === epoch
      && resource(getState())
      && (!location || getState().nav?.location === initialLocation);
    const sessionDispatch = ownedDispatch(dispatch, getState);
    return { epoch, isCurrent, dispatch: (action) => (isCurrent() ? sessionDispatch(action) : undefined) };
  };
}
