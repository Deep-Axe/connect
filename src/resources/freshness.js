export const SUBSCRIPTION_FRESH_MS = 60 * 1000;
export const SIGNED_URL_MARGIN_MS = 5 * 60 * 1000;

export function fileInventoryExpiry(files, now) {
  let expiresAt = Number.MAX_SAFE_INTEGER;
  for (const urls of Object.values(files ?? {})) {
    if (!Array.isArray(urls)) continue;
    for (const url of urls) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return now;
      }
      const expiry = parsed.searchParams.get('se');
      if (expiry == null) continue; // unsigned public assets have no SAS expiry
      const timestamp = Date.parse(expiry);
      if (!Number.isFinite(timestamp)) return now;
      expiresAt = Math.min(expiresAt, timestamp - SIGNED_URL_MARGIN_MS);
    }
  }
  return expiresAt;
}
