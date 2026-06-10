import { describe, it, expect } from 'vitest';
// @ts-ignore
import { rockUsageTool } from '../../src/tools/rock-usage.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';
// @ts-ignore
import { USAGE_NUDGE } from '../../src/tools/usage-nudge.js';

describe('rock_usage tool', () => {
  it('should return real guide content in readonly mode', async () => {
    const ctx = {
      mode: 'readonly',
    } as unknown as OAuthRockContext;

    const result = await rockUsageTool.handle({}, null, ctx);
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text ?? '';
    expect(text).toContain('Favor Church');
    expect(text.length).toBeGreaterThan(1000);
    expect(text).not.toContain('Write & Mutation Safety');
  });

  it('should return real guide content in readwrite mode', async () => {
    const ctx = {
      mode: 'readwrite',
    } as unknown as OAuthRockContext;

    const result = await rockUsageTool.handle({}, null, ctx);
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text ?? '';
    expect(text).toContain('Favor Church');
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain('Write & Mutation Safety');
  });

  it('should default to readonly when mode is missing', async () => {
    const ctx = {} as unknown as OAuthRockContext;

    const result = await rockUsageTool.handle({}, null, ctx);
    const text = result.content[0].text ?? '';
    expect(text).not.toContain('Write & Mutation Safety');
  });

  it('should embed USAGE_NUDGE in readonly description', () => {
    const desc = rockUsageTool.descriptionForMode('readonly');
    expect(desc).toContain(USAGE_NUDGE);
    expect(desc).toContain('Favor Church');
    expect(desc).not.toContain('Write & Mutation Safety');
  });

  it('should embed USAGE_NUDGE in readwrite description', () => {
    const desc = rockUsageTool.descriptionForMode('readwrite');
    expect(desc).toContain(USAGE_NUDGE);
    expect(desc).toContain('Favor Church');
    expect(desc).toContain('Write & Mutation Safety');
  });
});
