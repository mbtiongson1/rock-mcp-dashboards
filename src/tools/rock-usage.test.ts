import { describe, it, expect } from 'vitest';
// @ts-ignore
import { rockUsageTool } from './rock-usage.js';
// @ts-ignore
import { OAuthRockContext } from '../http/oauth.js';

describe('rock_usage tool', () => {
  it('should return the guide stub text', async () => {
    const ctx = {
      mode: 'readonly',
    } as unknown as OAuthRockContext;

    const result = await rockUsageTool.handle({}, null, ctx);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Guide is embedded');
  });

  it('should return readwrite description in readwrite mode', () => {
    const desc = rockUsageTool.descriptionForMode('readwrite');
    expect(desc).toContain('Favor Church operating rules');
  });
});
