import { OAuthRockContext } from '../http/oauth.js';

export type EndpointKind = 'mcp' | 'readonly';
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
 * Thrown when an authenticated, Rock-linked caller is neither a staff member,
 * nor an administrator, nor an active group leader. MCP access is restricted
 * to staff, admins, and active group leaders; everyone else is denied (403)
 * on every endpoint.
 */
export class AccessDeniedError extends Error {
  constructor(message: string, public email?: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/**
 * Convert the requested endpoint and OAuth/Rock context into the effective MCP
 * mode. The `mcp` (auto) endpoint upgrades to `readwrite` only when the OAuth
 * token carries `write` AND the resolved person is either an RSR admin or
 * leads at least one group (`ledGroupIds.length > 0`). Plain staff with
 * neither admin rights nor group leadership stay `readonly` regardless of
 * scope.
 */
export function resolveMode(endpoint: EndpointKind, ctx: OAuthRockContext): McpMode {
  if (endpoint === 'readonly') {
    if (!ctx.scopes.has('read')) {
      throw new ScopeError('Missing scope: read');
    }
    return 'readonly';
  }

  // Auto endpoint (mcp)
  if (!ctx.scopes.has('read')) {
    throw new ScopeError('Missing scope: read');
  }

  if (ctx.scopes.has('write') && (ctx.rockUser.isRsrAdmin || ctx.rockUser.ledGroupIds.length > 0)) {
    return 'readwrite';
  }

  return 'readonly';
}
