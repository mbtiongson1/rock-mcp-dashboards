import { describe, it, expect } from 'vitest';
import { rockMinistryTool } from './rock-ministry.js';
import { RockClientImpl } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';
import { DiscoveryService } from '../discovery/discovery-service.js';

describe('rock_ministry Integration Test', () => {
  const hasEnv = !!(process.env.ROCK_PUBLIC_URL && process.env.ROCK_API_KEY);

  it.runIf(hasEnv)('should query groups on the live preview server', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const discoveryService = new DiscoveryService(client, null);

    const mockCtx = {
      mode: 'readonly',
      scopes: new Set(['read']),
      request: {
        requestId: 'ministry-int-req-123',
        sessionId: 'ministry-int-sess-456',
      },
      rockClient: client,
      discoveryService,
    } as unknown as OAuthRockContext;

    // Call groups for connectGroup
    const result = await rockMinistryTool.handle(
      { action: 'groups', kind: 'connectGroup' },
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
