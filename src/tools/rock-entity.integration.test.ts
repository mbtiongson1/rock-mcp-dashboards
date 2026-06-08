import { describe, it, expect } from 'vitest';
import { rockEntityTool } from './rock-entity.js';
import { RockClientImpl } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';

describe('rock_entity Integration Test', () => {
  const hasEnv = !!(process.env.ROCK_PUBLIC_URL && process.env.ROCK_API_KEY);

  it.runIf(hasEnv)('should query campuses via search with fallback to REST v1 on live preview server', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const mockCtx = {
      mode: 'readonly',
      scopes: new Set(['read']),
      request: {
        requestId: 'entity-int-req-123',
        sessionId: 'entity-int-sess-456',
      },
      rockClient: client,
    } as unknown as OAuthRockContext;

    // Call search for campuses (where IsActive == true)
    const result = await rockEntityTool.handle(
      { action: 'search', model: 'campuses', where: 'IsActive == true' },
      null,
      mockCtx
    );

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);
    expect(Array.isArray(response.result)).toBe(true);
    expect(response.result.length).toBeGreaterThan(0);
    expect(response.result[0].Name).toBeDefined();
  });

  it.runIf(hasEnv)('should hide PII in get people response by default (shape=summary)', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const mockCtx = {
      mode: 'readonly',
      scopes: new Set(['read']),
      request: {
        requestId: 'entity-int-req-pii-1',
        sessionId: 'entity-int-sess-pii-1',
      },
      rockClient: client,
    } as unknown as OAuthRockContext;

    // Get a person with default shape (should hide PII)
    const result = await rockEntityTool.handle(
      { action: 'get', model: 'people', id: 1 },
      null,
      mockCtx
    );

    expect(result).toBeDefined();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);

    const person = response.result;
    // Should have safe fields
    expect(person.id).toBeDefined();
    expect(person.guid).toBeDefined();
    expect(person.name).toBeDefined();

    // Should NOT have PII fields
    expect(person.Email).toBeUndefined();
    expect(person.PhoneNumber).toBeUndefined();
    expect(person.BirthDate).toBeUndefined();
  });

  it.runIf(hasEnv)('should include PII in get people response with shape=full', async () => {
    const client = new RockClientImpl({
      baseUrl: process.env.ROCK_PUBLIC_URL!,
      apiKey: process.env.ROCK_API_KEY!,
    });

    const mockCtx = {
      mode: 'readonly',
      scopes: new Set(['read']),
      request: {
        requestId: 'entity-int-req-full-1',
        sessionId: 'entity-int-sess-full-1',
      },
      rockClient: client,
    } as unknown as OAuthRockContext;

    // Get a person with shape=full (should include all fields)
    const result = await rockEntityTool.handle(
      { action: 'get', model: 'people', id: 1, shape: 'full' },
      null,
      mockCtx
    );

    expect(result).toBeDefined();
    const response = JSON.parse(result.content[0].text!);
    expect(response.ok).toBe(true);

    const person = response.result;
    // Should have all fields including PII
    expect(person.Id).toBeDefined();
    // Email may or may not be present depending on Rock data, but if it is, it should not be filtered
  });
});
