import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { RockClientImpl } from '../../src/rock/client.js';
// @ts-ignore
import { RockCredentialStrategy, UserJwtStrategy } from '../../src/rock/auth-strategy.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

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

describe('UserJwtStrategy', () => {
  it('sends the raw Rock user token as a Bearer token', async () => {
    const strategy = new UserJwtStrategy();
    const ctx = {
      oauth: {
        subject: 'user-123',
        accessTokenHash: 'hashed-token-must-not-be-used',
      },
      rockUserToken: 'raw-rock-user-token',
    } as unknown as OAuthRockContext;

    const headers = await strategy.getHeaders(ctx, {
      method: 'GET',
      path: '/api/People/1',
    });

    expect(headers).toEqual({
      Authorization: 'Bearer raw-rock-user-token',
    });
    expect(headers.Authorization).not.toContain('hashed-token-must-not-be-used');
  });

  it('throws when the raw Rock user token is missing', async () => {
    const strategy = new UserJwtStrategy();
    const ctx = {
      oauth: {
        subject: 'user-123',
        accessTokenHash: 'hashed-token-must-not-be-used',
      },
    } as unknown as OAuthRockContext;

    await expect(strategy.getHeaders(ctx, {
      method: 'GET',
      path: '/api/People/1',
    })).rejects.toThrow('Missing Rock user token');
  });
});
