import { describe, it, expect } from 'vitest';
// @ts-ignore
import { resolveMode, EndpointKind, ScopeError } from '../../src/mcp/modes.js';
// @ts-ignore
import { OAuthRockContext } from '../../src/http/oauth.js';

describe('Endpoint Mode Resolution', () => {
  const baseContext = (scopes: string[], isRsrAdmin = false): Partial<OAuthRockContext> => ({
    scopes: new Set(scopes as any),
    rockUser: {
      isRsrAdmin,
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

  it('should resolve to readwrite for readwrite endpoint with read & write scope', () => {
    const ctx = baseContext(['read', 'write']);
    const mode = resolveMode('readwrite', ctx as OAuthRockContext);
    expect(mode).toBe('readwrite');
  });

  it('should throw for readwrite endpoint if write scope is missing', () => {
    const ctx = baseContext(['read']);
    expect(() => resolveMode('readwrite', ctx as OAuthRockContext)).toThrow('Missing scope: write');
  });

  it('should resolve to readonly for auto endpoint if user lacks write scope', () => {
    const ctx = baseContext(['read'], true);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readonly');
  });

  it('should resolve to readonly for auto endpoint if user has write scope but is not RSR admin', () => {
    const ctx = baseContext(['read', 'write'], false);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readonly');
  });

  it('should resolve to readwrite for auto endpoint if user has write scope and is RSR admin', () => {
    const ctx = baseContext(['read', 'write'], true);
    const mode = resolveMode('mcp', ctx as OAuthRockContext);
    expect(mode).toBe('readwrite');
  });

  it('should throw ScopeError (not generic Error) for missing write scope on readwrite endpoint', () => {
    const ctx = baseContext(['read']);
    expect(() => resolveMode('readwrite', ctx as OAuthRockContext)).toThrow(ScopeError);
  });

  it('should throw ScopeError with correct message', () => {
    const ctx = baseContext(['read']);
    expect(() => resolveMode('readwrite', ctx as OAuthRockContext)).toThrow('Missing scope: write');
  });
});
