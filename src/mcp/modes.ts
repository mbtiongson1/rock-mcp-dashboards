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

export class PersonResolutionError extends Error {
  constructor(message: string, public email?: string) {
    super(message);
    this.name = 'PersonResolutionError';
  }
}

/**
 * Convert the requested endpoint and OAuth/Rock context into the effective MCP
 * mode. The auto endpoint intentionally upgrades only when both the OAuth
 * token carries `write` and Rock says the resolved person is an RSR admin.
 */
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
