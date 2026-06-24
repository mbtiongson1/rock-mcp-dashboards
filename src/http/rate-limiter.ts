import type { Redis } from '@upstash/redis';

/**
 * Redis-backed fixed-window rate limiter, keyed by an arbitrary string.
 * Uses Redis INCR + EXPIRE within a fixed window.
 *
 * Keys are namespaced as `${prefix}${segment}${key}` where:
 * - `prefix` is the shared Redis key prefix (see getRedisPrefix)
 * - `segment` identifies the limiter (e.g. `dcr:ratelimit:`, `mcp:ratelimit:`)
 * - `key` is the per-caller bucket (an IP, a hashed subject, etc.)
 *
 * If Redis is not configured (null), rate limiting is skipped (fail-open for
 * local dev / stdio). On any Redis error, the limiter also fails open.
 */
export class RateLimiter {
  constructor(
    private redis: Redis | null,
    private prefix: string,
    private segment: string,
    private maxRequests: number,
    private windowSeconds: number
  ) {}

  /**
   * Check if the given key is within the rate limit.
   * Returns true if allowed, false if rate limited.
   * On Redis errors or when Redis is unconfigured, returns true (fail-open).
   */
  public async checkLimit(key: string): Promise<boolean> {
    if (!this.redis) {
      // No Redis configured; skip rate limiting (fail-open for local dev)
      return true;
    }

    const redisKey = `${this.prefix}${this.segment}${key}`;

    try {
      const current = await this.redis.incr(redisKey);

      // Set expiration on first increment
      if (current === 1) {
        await this.redis.expire(redisKey, this.windowSeconds);
      }

      return current <= this.maxRequests;
    } catch {
      // On any Redis error, fail open (allow the request)
      return true;
    }
  }
}

/** Key segment used for per-subject MCP request limiting. */
export const MCP_RATE_LIMIT_SEGMENT = 'mcp:ratelimit:';

/** Default MCP request limit per window if env is unset. */
export const MCP_RATE_LIMIT_REQUESTS_DEFAULT = 120;
/** Default MCP rate-limit window (seconds) if env is unset. */
export const MCP_RATE_LIMIT_WINDOW_SECONDS_DEFAULT = 60;

/**
 * Read a positive-integer env var, falling back to a default when the var is
 * unset, blank, or not a finite positive integer.
 */
function positiveIntEnv(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/** Resolve the configured MCP per-subject request limit (requests per window). */
export function mcpRateLimitRequests(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.ROCK_MCP_RATE_LIMIT_REQUESTS, MCP_RATE_LIMIT_REQUESTS_DEFAULT);
}

/** Resolve the configured MCP rate-limit window in seconds. */
export function mcpRateLimitWindowSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntEnv(env.ROCK_MCP_RATE_LIMIT_WINDOW_SECONDS, MCP_RATE_LIMIT_WINDOW_SECONDS_DEFAULT);
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
