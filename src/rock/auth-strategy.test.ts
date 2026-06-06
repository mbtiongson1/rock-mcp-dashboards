import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { RockClientImpl } from './client.js';
// @ts-ignore
import { RockCredentialStrategy } from './auth-strategy.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

describe('RockCredentialStrategy', () => {
  let client: RockClientImpl;
  const mockCtx = {
    scopes: new Set(['read']),
    request: {
      requestId: 'req-123',
      sessionId: 'sess-456',
    },
  } as unknown as OAuthRockContext;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('should use custom credential strategy headers', async () => {
    const mockStrategy: RockCredentialStrategy = {
      getHeaders: async (_ctx, _spec) => ({
        'Authorization': 'Bearer custom-jwt-token',
        'X-Custom-Auth': 'yes',
      }),
      authorize: async () => ({ allowed: true }),
    };

    client = new RockClientImpl({
      baseUrl: 'https://rock.example.com',
      credentialStrategy: mockStrategy,
    });

    const mockResponse = {
      ok: true,
      json: async () => ({ Id: 123 }),
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    await client.get(mockCtx, '/api/v2/models/people/123');

    expect(fetch).toHaveBeenCalledWith(
      'https://rock.example.com/api/v2/models/people/123',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer custom-jwt-token',
          'X-Custom-Auth': 'yes',
          'Content-Type': 'application/json',
        }),
      })
    );
  });
});
