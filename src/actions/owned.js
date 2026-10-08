// Async work belongs to the session it started in. A dispatch made through
// ownedDispatch carries that session's epoch (nested thunks included), and
// the reducer ignores actions from an earlier epoch, so a response arriving
// after logout or a session change cannot write into the new session.
export function ownedDispatch(dispatch, getState) {
  const epoch = getState().sessionEpoch;
  const owned = (action) => (typeof action === 'function'
    ? dispatch((_dispatch, ...rest) => action(owned, ...rest))
    : dispatch({ ...action, epoch }));
  return owned;
}
