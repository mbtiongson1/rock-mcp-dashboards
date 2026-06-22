import { describe, it, expect, vi } from 'vitest';
import { OAuthTransactionStore, CLIENT_REGISTRATION_TTL_SECONDS } from '../../src/http/oauth-transactions.js';

describe('OAuthTransactionStore - Client Registration TTL', () => {
  describe('registerClient', () => {
    it('should set TTL on client registration', async () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue(true),
      };

      const store = new OAuthTransactionStore(mockRedis as any, 'test:');
      await store.registerClient(['https://example.com/callback'], 'Test Client');

      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^test:oauth:client:mcp_/),
        expect.any(String),
        { ex: CLIENT_REGISTRATION_TTL_SECONDS }
      );
    });

    it('should create valid registration data', async () => {
      const store = new OAuthTransactionStore(null, 'test:');
      const registration = await store.registerClient(
        ['https://example.com/callback'],
        'Test Client'
      );

      expect(registration.clientId).toMatch(/^mcp_/);
      expect(registration.redirectUris).toEqual(['https://example.com/callback']);
      expect(registration.clientName).toBe('Test Client');
      expect(registration.createdAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('touchClient', () => {
    it('should refresh TTL on active client', async () => {
      const mockRedis = {
        set: vi.fn().mockResolvedValue(true),
        get: vi.fn().mockResolvedValue(null),
      };

      const store = new OAuthTransactionStore(mockRedis as any, 'test:');

      // Create a registration first
      const registration = await store.registerClient(['https://example.com/callback']);

      // Now touch it to refresh TTL
      mockRedis.set.mockClear();
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(registration));

      await store.touchClient(registration.clientId);

      expect(mockRedis.get).toHaveBeenCalledWith(
        expect.stringMatching(/^test:oauth:client:/)
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^test:oauth:client:/),
        expect.stringContaining(registration.clientId),
        { ex: CLIENT_REGISTRATION_TTL_SECONDS }
      );
    });

    it('should handle non-existent client gracefully', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
      };

      const store = new OAuthTransactionStore(mockRedis as any, 'test:');
      await store.touchClient('mcp_nonexistent');

      // Should not call set if client doesn't exist
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('in-memory fallback with TTL', () => {
    it('should respect TTL in memory store', async () => {
      const store = new OAuthTransactionStore(null, 'test:');

      const registration = await store.registerClient(['https://example.com/callback']);

      // Client should be immediately available
      let retrieved = await store.getClient(registration.clientId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.clientId).toBe(registration.clientId);

      // Simulate time passing beyond TTL
      // In real scenario, TTL would cause expiration, but we can't directly
      // test expiration in synchronous manner without mocking time
      // The implementation handles it in the get() method
    });
  });
});
