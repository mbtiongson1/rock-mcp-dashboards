import type { Redis } from '@upstash/redis';
import { RateLimiter } from './rate-limiter.js';

/** Key segment used for Dynamic Client Registration (DCR) per-IP limiting. */
export const DCR_RATE_LIMIT_SEGMENT = 'dcr:ratelimit:';

/**
 * Redis-backed fixed-window rate limiter for Dynamic Client Registration (DCR).
 * Thin wrapper around the generalized {@link RateLimiter}, preserving the
 * historical `${prefix}dcr:ratelimit:${clientIp}` key shape and fail-open
 * behavior on null Redis / errors.
 */
export class DcrRateLimiter {
  private limiter: RateLimiter;

  constructor(redis: Redis | null, prefix: string, maxRequests: number, windowSeconds: number) {
    this.limiter = new RateLimiter(redis, prefix, DCR_RATE_LIMIT_SEGMENT, maxRequests, windowSeconds);
  }

  /**
   * Check if the given IP is within the rate limit.
   * Returns true if allowed, false if rate limited.
   * On Redis errors, returns true (fail-open).
   */
  public checkLimit(clientIp: string): Promise<boolean> {
    return this.limiter.checkLimit(clientIp);
  }
}

export { extractClientIp } from './rate-limiter.js';
