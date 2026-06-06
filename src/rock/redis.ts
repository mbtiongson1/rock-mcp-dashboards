import { Redis } from '@upstash/redis';

/**
 * Create a Redis client from environment variables.
 * Returns null if env vars are not set (for development/fallback to in-memory).
 */
export function createRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  return new Redis({ url, token });
}

/**
 * Get the Redis key prefix from environment or use default.
 */
export function getRedisPrefix(): string {
  return process.env.ROCK_MCP_REDIS_PREFIX || 'rock-mcp:prod:';
}
