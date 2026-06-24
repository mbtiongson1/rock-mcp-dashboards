import type { Redis } from '@upstash/redis';
import { RateLimiter } from './rate-limiter.js';

/** Key segment used for Dynamic Client Registration (DCR) per-IP limiting. */
export const DCR_RATE_LIMIT_SEGMENT = 'dcr:ratelimit:';

/**
 * Redis-backed fixed-window rate limiter for Dynamic Client Registration (DCR).
 * Thin wrapper around the generalized {@link RateLimiter}, preserving the
 * historical `${prefix}dcr:ratelimit:${clientIp}` key shape. When Redis is null
 * or errors, behavior follows `failClosed`: fail-open (default, dev) or
 * fail-closed (deny — used in production so a Redis outage cannot silently
 * disable rate limiting).
 */
export class DcrRateLimiter {
  private limiter: RateLimiter;

  constructor(
    redis: Redis | null,
    prefix: string,
    maxRequests: number,
    windowSeconds: number,
    failClosed: boolean = false
  ) {
    this.limiter = new RateLimiter(
      redis,
      prefix,
      DCR_RATE_LIMIT_SEGMENT,
      maxRequests,
      windowSeconds,
      failClosed
    );
  }

  /**
   * Check if the given IP is within the rate limit.
   * Returns true if allowed, false if rate limited.
   */
  public checkLimit(clientIp: string): Promise<boolean> {
    return this.limiter.checkLimit(clientIp);
  }
}

export { extractClientIp } from './rate-limiter.js';
