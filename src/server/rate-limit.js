import { ApiError } from './errors.js';

// Process-local load shedding supplements the authoritative limits in Sheets.
// IP is deliberately not an identity or authorization signal.
export class RateLimiter {
  constructor({ now = Date.now, maxEntries = 10000 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.buckets = new Map();
  }

  take(key, limit, windowMs) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (this.buckets.size >= this.maxEntries) {
        for (const [candidate, value] of this.buckets) if (value.until <= now) this.buckets.delete(candidate);
        if (this.buckets.size >= this.maxEntries && !bucket) throw new ApiError(503, 'server_busy', 'Сервер занят. Попробуйте позже.');
      }
      bucket = { count: 0, until: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) throw new ApiError(429, 'rate_limited', 'Слишком много запросов. Попробуйте позже.');
    bucket.count += 1;
  }
}
