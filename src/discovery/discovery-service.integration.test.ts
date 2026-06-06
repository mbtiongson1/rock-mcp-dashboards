import { describe, it, expect } from 'vitest';
import { DiscoveryService } from './discovery-service.js';
import { RockClientImpl } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';

describe('DiscoveryService Integration Test', () => {
  const hasEnv = !!(process.env.ROCK_PUBLIC_URL && process.env.ROCK_API_KEY);

  it.runIf(hasEnv)('should run discovery against the live preview server', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const mockCtx = {
      scopes: new Set(['read']),
      request: {
        requestId: 'discovery-int-req-123',
        sessionId: 'discovery-int-sess-456',
      },
    } as unknown as OAuthRockContext;

    const service = new DiscoveryService(client, null);
    const map = await service.getMap(mockCtx);

    expect(map).toBeDefined();
    expect(map.campuses).toBeDefined();
    // We expect some active campuses on the Favor Church server (e.g. Manila, etc.)
    expect(map.campuses.length).toBeGreaterThan(0);
    expect(map.campuses[0].name).toBeDefined();

    // Verify group types were discovered
    expect(map.groupTypes).toBeDefined();
    // Connect groups or ministry teams or other types should be parsed
    const totalGroupTypes = map.groupTypes.connectGroups.length + map.groupTypes.ministryTeams.length + map.groupTypes.other.length;
    expect(totalGroupTypes).toBeGreaterThan(0);
  }, 15000);
});
