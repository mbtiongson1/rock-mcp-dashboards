import { OAuthRockContext } from '../http/oauth.js';

export type EndpointKind = 'mcp' | 'readonly' | 'readwrite';
export type McpMode = 'readonly' | 'readwrite';
export type McpScope = 'read' | 'write';

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

export function resolveMode(endpoint: EndpointKind, ctx: OAuthRockContext): McpMode {
  if (endpoint === 'readonly') {
    if (!ctx.scopes.has('read')) {
      throw new ScopeError('Missing scope: read');
    }
    return 'readonly';
  }

  if (endpoint === 'readwrite') {
    if (!ctx.scopes.has('read')) {
      throw new ScopeError('Missing scope: read');
    }
    if (!ctx.scopes.has('write')) {
      throw new ScopeError('Missing scope: write');
    }
    return 'readwrite';
  }

  // Auto endpoint (mcp)
  if (!ctx.scopes.has('read')) {
    throw new ScopeError('Missing scope: read');
  }

  if (ctx.scopes.has('write') && ctx.rockUser.isRsrAdmin) {
    return 'readwrite';
  }

  return 'readonly';
}
