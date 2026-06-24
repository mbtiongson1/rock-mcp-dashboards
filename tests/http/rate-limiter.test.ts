import { describe, it, expect, vi } from 'vitest';
import {
  RateLimiter,
  mcpRateLimitRequests,
  mcpRateLimitWindowSeconds,
  MCP_RATE_LIMIT_REQUESTS_DEFAULT,
  MCP_RATE_LIMIT_WINDOW_SECONDS_DEFAULT,
} from '../../src/http/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows requests at or under the limit', async () => {
    const mockRedis = {
      incr: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3),
      expire: vi.fn().mockResolvedValue(true),
    };
    const limiter = new RateLimiter(mockRedis as any, 'p:', 'seg:', 3, 60);

    expect(await limiter.checkLimit('subject-a')).toBe(true);
    expect(await limiter.checkLimit('subject-a')).toBe(true);
    expect(await limiter.checkLimit('subject-a')).toBe(true); // exactly at limit
  });

  it('denies requests over the limit', async () => {
    const mockRedis = {
      incr: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(4),
      expire: vi.fn().mockResolvedValue(true),
    };
    const limiter = new RateLimiter(mockRedis as any, 'p:', 'seg:', 3, 60);

    expect(await limiter.checkLimit('subject-a')).toBe(true); // at limit
    expect(await limiter.checkLimit('subject-a')).toBe(false); // over limit
  });

  it('builds the redis key from prefix + segment + key and sets TTL on first hit', async () => {
    const mockRedis = {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(true),
    };
    const limiter = new RateLimiter(mockRedis as any, 'rock-mcp:prod:', 'mcp:ratelimit:', 10, 60);

    await limiter.checkLimit('hashed-subject');

    expect(mockRedis.incr).toHaveBeenCalledWith('rock-mcp:prod:mcp:ratelimit:hashed-subject');
    expect(mockRedis.expire).toHaveBeenCalledWith('rock-mcp:prod:mcp:ratelimit:hashed-subject', 60);
  });

  it('isolates buckets per key (two subjects do not share a counter)', async () => {
    const mockRedis = {
      incr: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1),
      expire: vi.fn().mockResolvedValue(true),
    };
    const limiter = new RateLimiter(mockRedis as any, 'p:', 'mcp:ratelimit:', 5, 60);

    expect(await limiter.checkLimit('subject-a')).toBe(true);
    expect(await limiter.checkLimit('subject-b')).toBe(true);
    expect(mockRedis.incr).toHaveBeenNthCalledWith(1, 'p:mcp:ratelimit:subject-a');
    expect(mockRedis.incr).toHaveBeenNthCalledWith(2, 'p:mcp:ratelimit:subject-b');
  });

  it('fails open when Redis is not configured', async () => {
    const limiter = new RateLimiter(null, 'p:', 'seg:', 1, 60);
    expect(await limiter.checkLimit('subject-a')).toBe(true);
    expect(await limiter.checkLimit('subject-a')).toBe(true);
  });

  it('fails open on Redis error', async () => {
    const mockRedis = {
      incr: vi.fn().mockRejectedValue(new Error('boom')),
      expire: vi.fn().mockResolvedValue(true),
    };
    const limiter = new RateLimiter(mockRedis as any, 'p:', 'seg:', 1, 60);
    expect(await limiter.checkLimit('subject-a')).toBe(true);
  });
});

describe('mcp rate-limit env helpers', () => {
  it('returns defaults when env is unset', () => {
    expect(mcpRateLimitRequests({})).toBe(MCP_RATE_LIMIT_REQUESTS_DEFAULT);
    expect(mcpRateLimitWindowSeconds({})).toBe(MCP_RATE_LIMIT_WINDOW_SECONDS_DEFAULT);
  });

  it('reads valid positive integers from env', () => {
    expect(mcpRateLimitRequests({ ROCK_MCP_RATE_LIMIT_REQUESTS: '5' } as any)).toBe(5);
    expect(mcpRateLimitWindowSeconds({ ROCK_MCP_RATE_LIMIT_WINDOW_SECONDS: '30' } as any)).toBe(30);
  });

  it('falls back to defaults on invalid env values', () => {
    expect(mcpRateLimitRequests({ ROCK_MCP_RATE_LIMIT_REQUESTS: 'abc' } as any)).toBe(
      MCP_RATE_LIMIT_REQUESTS_DEFAULT
    );
    expect(mcpRateLimitRequests({ ROCK_MCP_RATE_LIMIT_REQUESTS: '0' } as any)).toBe(
      MCP_RATE_LIMIT_REQUESTS_DEFAULT
    );
    expect(mcpRateLimitWindowSeconds({ ROCK_MCP_RATE_LIMIT_WINDOW_SECONDS: '-5' } as any)).toBe(
      MCP_RATE_LIMIT_WINDOW_SECONDS_DEFAULT
    );
  });
});
