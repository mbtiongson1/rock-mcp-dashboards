import { describe, it, expect } from 'vitest';
// @ts-ignore
import { resolveMode, ScopeError } from '../../src/mcp/modes.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

describe('Endpoint Mode Resolution', () => {
  const baseContext = (
    scopes: string[],
    isRsrAdmin = false,
    isStaff = false,
    ledGroupIds: number[] = []
  ): Partial<OAuthRockContext> => ({
    scopes: new Set(scopes as any),
    rockUser: {
      isRsrAdmin,
      isStaff,
      ledGroupIds,
    },
  }) as any;

  it('should resolve to readonly for readonly endpoint with read scope', () => {
    const ctx = baseContext(['read']);
    const mode = resolveMode('readonly', ctx as OAuthRockContext);
    expect(mode).toBe('readonly');
  });

  it('should throw for readonly endpoint if read scope is missing', () => {
    const ctx = baseContext([]);
    expect(() => resolveMode('readonly', ctx as OAuthRockContext)).toThrow('Missing scope: read');
  });

  it('should resolve to readonly for auto endpoint if user lacks write scope', () => {
    const ctx = baseContext(['read'], true);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readonly');
  });

  it('should resolve to readonly for auto endpoint if user has write scope but is not RSR admin and leads no groups', () => {
    const ctx = baseContext(['read', 'write'], false);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readonly');
  });

  it('should resolve to readwrite for auto endpoint if user has write scope and is RSR admin', () => {
    const ctx = baseContext(['read', 'write'], true);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readwrite');
  });

  it('should resolve to readwrite for auto endpoint if non-admin user leads a group and has write scope', () => {
    const ctx = baseContext(['read', 'write'], false, false, [5]);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readwrite');
  });

  it('should resolve to readonly for auto endpoint if leader lacks write scope', () => {
    const ctx = baseContext(['read'], false, false, [5]);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readonly');
  });

  it('should resolve to readonly for auto endpoint for plain staff (no leadership) even with write scope', () => {
    const ctx = baseContext(['read', 'write'], false, true, []);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readonly');
  });

  it('should throw ScopeError for missing read scope on auto endpoint', () => {
    const ctx = baseContext([], false, false, [5]);
    expect(() => resolveMode('mcp', ctx as OAuthRockContext)).toThrow(ScopeError);
    expect(() => resolveMode('mcp', ctx as OAuthRockContext)).toThrow('Missing scope: read');
  });
});
