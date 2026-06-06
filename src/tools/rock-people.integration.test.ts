import { describe, it, expect } from 'vitest';
import { rockPeopleTool } from './rock-people.js';
import { RockClientImpl } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';

describe('rock_people Integration Test', () => {
  const hasEnv = !!(process.env.ROCK_PUBLIC_URL && process.env.ROCK_API_KEY);

  it.runIf(hasEnv)('should find people on the live preview server', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const mockCtx = {
      mode: 'readonly',
      scopes: new Set(['read']),
      request: {
        requestId: 'people-int-req-123',
        sessionId: 'people-int-sess-456',
      },
      rockClient: client,
    } as unknown as OAuthRockContext;

    // Call find for people with a common search term, e.g. "Admin" or "Favor"
    const result = await rockPeopleTool.handle(
      { action: 'find', query: 'Admin' },
      null,
      mockCtx
    );

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.result)).toBe(true);
  });
});
