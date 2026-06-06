import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { RockClientImpl } from './client.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

describe('RockClient', () => {
  let client: RockClientImpl;
  const mockCtx = {
    scopes: new Set(['read']),
    request: {
      requestId: 'req-123',
      sessionId: 'sess-456',
    },
  } as unknown as OAuthRockContext;

  beforeEach(() => {
    client = new RockClientImpl({
      baseUrl: 'https://rock.example.com',
      apiKey: 'test-api-key',
      timeoutMs: 1000,
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  it('should successfully make GET request with proper headers', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ Id: 123, Name: 'Test Entity' }),
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    const result = await client.get<any>(mockCtx, '/api/v2/models/people/123');

    expect(fetch).toHaveBeenCalledWith(
      'https://rock.example.com/api/v2/models/people/123',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'Authorization-Token': 'test-api-key',
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(result.Id).toBe(123);
  });

  it('should normalize HTTP errors into readable Rock errors', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'Detailed error message from Rock',
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    await expect(client.get(mockCtx, '/api/v2/models/people/999')).rejects.toThrow(
      'Rock API error (400 Bad Request): Detailed error message from Rock'
    );
  });
});
