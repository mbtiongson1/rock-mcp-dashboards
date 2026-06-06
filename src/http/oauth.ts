import * as crypto from 'crypto';
import * as jose from 'jose';

export interface OAuthRockContext {
  endpoint: 'mcp' | 'readonly' | 'readwrite';
  mode: 'readonly' | 'readwrite';
  scopes: Set<'read' | 'write'>;
  oauth: {
    subject: string;
    email?: string;
    name?: string;
    accessTokenHash: string;
    issuer?: string;
  };
  rockUser: {
    personId?: number;
    personGuid?: string;
    personAliasId?: number;
    userLoginId?: number;
    userName?: string;
    isRsrAdmin: boolean;
  };
  request: {
    sessionId: string;
    requestId: string;
    ip?: string;
    userAgent?: string;
  };
}

// Extend Request type to include our oauthContext
declare global {
  namespace Express {
    interface Request {
      oauthContext?: OAuthRockContext;
    }
  }
}

export interface VerifyTokenOptions {
  verifyToken?: (token: string) => Promise<{ isValid: boolean; payload?: any; error?: string }>;
}

export function createAuthMiddleware(options: VerifyTokenOptions = {}) {
  const verifyToken = options.verifyToken || defaultVerifyToken;

  return async (req: any, res: any, next: any): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.substring(7);
    try {
      const { isValid, payload, error } = await verifyToken(token);
      if (!isValid || !payload) {
        res.status(401).json({ error: error || 'Invalid token' });
        return;
      }

      // Check required read scope
      const scopeStr = payload.scope || '';
      const scopes = new Set<string>(scopeStr.split(/\s+/).filter(Boolean));
      if (!scopes.has('read')) {
        res.status(403).json({ error: 'Missing required read scope' });
        return;
      }

      const mcpScopes = new Set<'read' | 'write'>();
      if (scopes.has('read')) mcpScopes.add('read');
      if (scopes.has('write')) mcpScopes.add('write');

      // Create session ID and request ID
      const sessionId = req.headers['x-mcp-session-id'] as string || crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const ip = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];

      // Generate access token hash for audit metadata
      const accessTokenHash = crypto.createHash('sha256').update(token).digest('hex');

      // Build context
      req.oauthContext = {
        endpoint: 'mcp', // default, resolved later
        mode: 'readonly', // default, resolved later
        scopes: mcpScopes,
        oauth: {
          subject: payload.sub || '',
          email: payload.email,
          name: payload.name,
          accessTokenHash,
          issuer: payload.iss,
        },
        rockUser: {
          isRsrAdmin: false, // default, resolved later
        },
        request: {
          sessionId,
          requestId,
          ip,
          userAgent,
        },
      };

      next();
    } catch (err: any) {
      res.status(401).json({ error: err.message || 'Authentication failed' });
    }
  };
}

async function defaultVerifyToken(token: string) {
  const jwksUrl = process.env.OAUTH_JWKS_URL;
  const issuer = process.env.OAUTH_ISSUER;
  const audience = process.env.OAUTH_AUDIENCE;

  if (!jwksUrl) {
    // In local dev without config, decode but warn or allow in development
    if (process.env.NODE_ENV !== 'production') {
      const decoded = jose.decodeJwt(token);
      return { isValid: true, payload: decoded };
    }
    return { isValid: false, error: 'OAUTH_JWKS_URL env var is not configured' };
  }

  try {
    const JWKS = jose.createRemoteJWKSet(new URL(jwksUrl));
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer,
      audience,
    });
    return { isValid: true, payload };
  } catch (err: any) {
    return { isValid: false, error: err.message };
  }
}
