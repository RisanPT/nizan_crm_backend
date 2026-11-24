// Small in-memory fixed-window rate limiter (per server process).
// Used for the public website enquiry form; a restart simply starts fresh.
export function createRateLimiter({ windowMs, max, maxKeys = 10_000 }) {
  const hits = new Map(); // key → { count, resetAt }

  return {
    /** Counts one attempt for `key`. → { allowed, retryAfterSec } */
    hit(key, now = Date.now()) {
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        if (hits.size >= maxKeys) {
          for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
          if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
        }
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= max,
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    },
    reset() {
      hits.clear();
    },
  };
}

// Best-effort visitor address. The first X-Forwarded-For entry is used when a
// proxy sets it. It can be faked by a caller without a proxy, so the enquiry
// form also limits per phone number and in total — faking it gains little.
export const clientIp = (req) => {
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
};
