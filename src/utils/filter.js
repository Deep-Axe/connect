const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;

export function getDefaultFilter(now = Date.now()) {
  const end = new Date(now).setMinutes(60, 0, 0); // next hour

  return {
    start: end - ONE_YEAR,
    end
  };
}
