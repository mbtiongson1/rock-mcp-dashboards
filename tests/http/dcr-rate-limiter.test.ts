import { describe, it, expect, vi } from 'vitest';
import { DcrRateLimiter, extractClientIp } from '../../src/http/dcr-rate-limiter.js';

describe('DcrRateLimiter', () => {
  describe('checkLimit', () => {
    it('should allow requests under the limit', async () => {
      const mockRedis = {
        incr: vi.fn()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(3),
        expire: vi.fn().mockResolvedValue(true),
      };

      const limiter = new DcrRateLimiter(mockRedis as any, 'test:', 10, 3600);

      const result1 = await limiter.checkLimit('192.168.1.1');
      const result2 = await limiter.checkLimit('192.168.1.1');
      const result3 = await limiter.checkLimit('192.168.1.1');

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(result3).toBe(true);
      expect(mockRedis.incr).toHaveBeenCalledTimes(3);
    });

    it('should reject requests exceeding the limit', async () => {
      const mockRedis = {
        incr: vi.fn()
          .mockResolvedValueOnce(10)
          .mockResolvedValueOnce(11),
        expire: vi.fn().mockResolvedValue(true),
      };

      const limiter = new DcrRateLimiter(mockRedis as any, 'test:', 10, 3600);

      const result1 = await limiter.checkLimit('192.168.1.1');
      const result2 = await limiter.checkLimit('192.168.1.1');

      expect(result1).toBe(true); // exactly at limit
      expect(result2).toBe(false); // exceeds limit
    });

    it('should set expiration on first increment', async () => {
      const mockRedis = {
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(true),
      };

      const limiter = new DcrRateLimiter(mockRedis as any, 'test:', 10, 3600);
      await limiter.checkLimit('192.168.1.1');

      expect(mockRedis.expire).toHaveBeenCalledWith('test:dcr:ratelimit:192.168.1.1', 3600);
    });

    it('should fail open when Redis is not configured', async () => {
      const limiter = new DcrRateLimiter(null, 'test:', 10, 3600);

      const result = await limiter.checkLimit('192.168.1.1');

      expect(result).toBe(true);
    });

    it('should fail open on Redis error', async () => {
      const mockRedis = {
        incr: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
        expire: vi.fn().mockResolvedValue(true),
      };

      const limiter = new DcrRateLimiter(mockRedis as any, 'test:', 10, 3600);

      const result = await limiter.checkLimit('192.168.1.1');

      expect(result).toBe(true); // fails open
    });

    it('should track different IPs independently', async () => {
      const mockRedis = {
        incr: vi.fn()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(1),
        expire: vi.fn().mockResolvedValue(true),
      };

      const limiter = new DcrRateLimiter(mockRedis as any, 'test:', 10, 3600);

      const result1 = await limiter.checkLimit('192.168.1.1');
      const result2 = await limiter.checkLimit('192.168.1.2');

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(mockRedis.incr).toHaveBeenNthCalledWith(1, 'test:dcr:ratelimit:192.168.1.1');
      expect(mockRedis.incr).toHaveBeenNthCalledWith(2, 'test:dcr:ratelimit:192.168.1.2');
    });
  });

  describe('extractClientIp', () => {
    it('should extract IP from x-forwarded-for header', () => {
      const request = new Request('http://example.com', {
        headers: {
          'x-forwarded-for': '192.168.1.1, 10.0.0.1',
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe('192.168.1.1');
    });

    it('should trim whitespace from x-forwarded-for', () => {
      const request = new Request('http://example.com', {
        headers: {
          'x-forwarded-for': '  192.168.1.1  , 10.0.0.1',
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe('192.168.1.1');
    });

    it('should fall back to x-real-ip header', () => {
      const request = new Request('http://example.com', {
        headers: {
          'x-real-ip': '10.0.0.1',
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe('10.0.0.1');
    });

    it('should prefer x-forwarded-for over x-real-ip', () => {
      const request = new Request('http://example.com', {
        headers: {
          'x-forwarded-for': '192.168.1.1',
          'x-real-ip': '10.0.0.1',
        },
      });

      const ip = extractClientIp(request);

      expect(ip).toBe('192.168.1.1');
    });

    it('should return unknown when no IP headers present', () => {
      const request = new Request('http://example.com', {
        headers: {},
      });

      const ip = extractClientIp(request);

      expect(ip).toBe('unknown');
    });
  });
});
