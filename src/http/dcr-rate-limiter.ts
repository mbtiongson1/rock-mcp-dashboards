import type { Redis } from '@upstash/redis';

/**
 * Redis-backed fixed-window rate limiter for Dynamic Client Registration (DCR).
 * Uses Redis INCR + EXPIRE for per-IP rate limiting.
 *
 * If Redis is not configured (null), rate limiting is skipped (fail-open for local dev).
 */
export class DcrRateLimiter {
  constructor(
    private redis: Redis | null,
    private prefix: string,
    private maxRequests: number,
    private windowSeconds: number
  ) {}

  /**
   * Check if the given IP is within the rate limit.
   * Returns true if allowed, false if rate limited.
   * On Redis errors, returns true (fail-open).
   */
  public async checkLimit(clientIp: string): Promise<boolean> {
    if (!this.redis) {
      // No Redis configured; skip rate limiting (fail-open for local dev)
      return true;
    }

    const key = `${this.prefix}dcr:ratelimit:${clientIp}`;

    try {
      const current = await this.redis.incr(key);

      // Set expiration on first increment
      if (current === 1) {
        await this.redis.expire(key, this.windowSeconds);
      }

      return current <= this.maxRequests;
    } catch {
      // On any Redis error, fail open (allow the request)
      return true;
    }
  }
}

/**
 * Extract the client IP from request headers.
 * Prefer x-forwarded-for (first IP, behind proxy), fall back to x-real-ip.
 * On Vercel, x-forwarded-for is authoritative.
 */
export function extractClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // x-forwarded-for can be a comma-separated list; take the first IP
    const firstIp = forwardedFor.split(',')[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Fallback to connection remote address (may not work behind proxy)
  return 'unknown';
}
