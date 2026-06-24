import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore
import { RockClientImpl, RockApiError } from '../../src/rock/client.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

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

  it('throws a RockApiError whose message omits the upstream body text', async () => {
    const SENSITIVE_BODY = 'Detailed error message from Rock with secrets';
    const mockResponse = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => SENSITIVE_BODY,
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    let caught: unknown;
    try {
      await client.get(mockCtx, '/api/v2/models/people/999');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RockApiError);
    const rockErr = caught as RockApiError;

    // The generic message must NOT leak the raw upstream body.
    expect(rockErr.message).toBe('Rock API error (400 Bad Request)');
    expect(rockErr.message).not.toContain(SENSITIVE_BODY);

    // The body is preserved on the instance for server-side logging only.
    expect(rockErr.bodyText).toBe(SENSITIVE_BODY);
    expect(rockErr.status).toBe(400);
    expect(rockErr.statusText).toBe('Bad Request');
  });
});
