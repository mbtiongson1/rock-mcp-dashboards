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
 * Thrown when a Rock-linked caller reaches an admin-only surface (the
 * `/mcp/readwrite` endpoint, or the write-upgrade path) without being a member
 * of the `RSR - Rock Administration` security role.
 */
export class AdminRequiredError extends Error {
  constructor(message: string, public email?: string) {
    super(message);
    this.name = 'AdminRequiredError';
  }
}

/**
 * Thrown when an authenticated, Rock-linked caller is neither a staff member
 * nor an administrator. MCP access is restricted to staff and admins; everyone
 * else is denied (403) on every endpoint.
 */
export class AccessDeniedError extends Error {
  constructor(message: string, public email?: string) {
    super(message);
    this.name = 'AccessDeniedError';
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
    // Writes are admin-only. A non-admin (e.g. a staff worker) is told
    // ADMIN_REQUIRED here regardless of the token's scopes — identity is
    // checked before scope so the reason returned is the actionable one.
    if (!ctx.rockUser.isRsrAdmin) {
      throw new AdminRequiredError(
        'The /mcp/readwrite endpoint is restricted to Rock administrators (the "RSR - Rock Administration" role).',
        ctx.oauth?.email
      );
    }
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
