import { OAuthRockContext } from '../http/oauth.js';

export interface RockRequestSpec {
  method: string;
  path: string;
  body?: unknown;
}

export interface RockActionDescriptor {
  model?: string;
  action: string;
  id?: string | number;
}

export interface AuthzDecision {
  allowed: boolean;
  reason?: string;
}

export interface RockCredentialStrategy {
  getHeaders(ctx: OAuthRockContext, request: RockRequestSpec): Promise<Record<string, string>>;
  authorize(ctx: OAuthRockContext, action: RockActionDescriptor): Promise<AuthzDecision>;
}

export class ApiKeyStrategy implements RockCredentialStrategy {
  constructor(private apiKey: string) {}

  public async getHeaders(_ctx: OAuthRockContext, _request: RockRequestSpec): Promise<Record<string, string>> {
    return {
      'Authorization-Token': this.apiKey,
    };
  }

  public async authorize(_ctx: OAuthRockContext, _action: RockActionDescriptor): Promise<AuthzDecision> {
    // API key has full access by default. Fine-grained checks are enforced at tool/application level.
    return { allowed: true };
  }
}

export class UserJwtStrategy implements RockCredentialStrategy {
  public async getHeaders(ctx: OAuthRockContext, _request: RockRequestSpec): Promise<Record<string, string>> {
    // Assuming the user context contains a native Rock JWT in ctx.oauth.rockUserJwt if configured.
    // In v1, we default to the OAuth access token if it is natively accepted by Rock.
    // We expect the user token to be configured or passed in the context.
    const token = (ctx as any).rockUserJwt || ctx.oauth.accessTokenHash; // fallback or placeholder
    return {
      'Authorization': `Bearer ${token}`,
    };
  }

  public async authorize(_ctx: OAuthRockContext, _action: RockActionDescriptor): Promise<AuthzDecision> {
    // Rock handles native user permissions directly via Bearer token.
    return { allowed: true };
  }
}
