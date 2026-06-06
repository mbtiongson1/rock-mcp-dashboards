import { describe, it, expect } from 'vitest';
import { RockClientImpl } from './client.js';
import { OAuthRockContext } from '../http/oauth.js';

describe('RockClient Integration Test', () => {
  const hasEnv = !!(process.env.ROCK_PUBLIC_URL && process.env.ROCK_API_KEY);

  it.runIf(hasEnv)('should call the live Rock preview server', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const mockCtx = {
      scopes: new Set(['read']),
      request: {
        requestId: 'integration-req-123',
        sessionId: 'integration-sess-456',
      },
    } as unknown as OAuthRockContext;

    // Call public campuses search endpoint
    const result = await client.get<any>(mockCtx, '/api/Campuses');
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      expect(result[0].Id).toBeDefined();
      expect(result[0].Name).toBeDefined();
    }
  });
});
