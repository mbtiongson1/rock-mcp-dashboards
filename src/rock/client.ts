import { OAuthRockContext } from '../http/oauth.js';
import { RockCredentialStrategy, ApiKeyStrategy } from './auth-strategy.js';

export interface RockRequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface RockClient {
  get<T>(ctx: OAuthRockContext, path: string, options?: RockRequestOptions): Promise<T>;
  post<T>(ctx: OAuthRockContext, path: string, body?: unknown, options?: RockRequestOptions): Promise<T>;
  put<T>(ctx: OAuthRockContext, path: string, body?: unknown, options?: RockRequestOptions): Promise<T>;
  patch<T>(ctx: OAuthRockContext, path: string, body?: unknown, options?: RockRequestOptions): Promise<T>;
  delete<T>(ctx: OAuthRockContext, path: string, options?: RockRequestOptions): Promise<T>;
}

export interface RockClientConfig {
  baseUrl: string;
  apiKey?: string;
  credentialStrategy?: RockCredentialStrategy;
  timeoutMs?: number;
}

export class RockClientImpl implements RockClient {
  private baseUrl: string;
  private credentialStrategy: RockCredentialStrategy;
  private defaultTimeoutMs: number;

  constructor(config: RockClientConfig) {
    // Normalize baseUrl: remove trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.defaultTimeoutMs = config.timeoutMs || 10000;
    
    if (config.credentialStrategy) {
      this.credentialStrategy = config.credentialStrategy;
    } else if (config.apiKey) {
      this.credentialStrategy = new ApiKeyStrategy(config.apiKey);
    } else {
      throw new Error('Either apiKey or credentialStrategy must be provided');
    }
  }

  private async request<T>(
    ctx: OAuthRockContext,
    method: string,
    path: string,
    body?: unknown,
    options?: RockRequestOptions
  ): Promise<T> {
    const urlPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${urlPath}`;

    const authHeaders = await this.credentialStrategy.getHeaders(ctx, { method, path, body });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...options?.headers,
    };

    // Include correlation IDs from context if available
    if (ctx && ctx.request) {
      headers['X-Request-ID'] = ctx.request.requestId;
      headers['X-Session-ID'] = ctx.request.sessionId;
    }

    const timeout = options?.timeoutMs || this.defaultTimeoutMs;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(id);

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Rock API error (${response.status} ${response.statusText}): ${errorText}`);
      }

      // Check content-type to see if it's JSON
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json() as T;
      }

      // Fallback for non-JSON responses
      const text = await response.text();
      return text as unknown as T;
    } catch (err: any) {
      clearTimeout(id);
      if (err.name === 'AbortError') {
        throw new Error(`Rock API request timed out after ${timeout}ms`);
      }
      throw err;
    }
  }

  public async get<T>(ctx: OAuthRockContext, path: string, options?: RockRequestOptions): Promise<T> {
    return this.request<T>(ctx, 'GET', path, undefined, options);
  }

  public async post<T>(ctx: OAuthRockContext, path: string, body?: unknown, options?: RockRequestOptions): Promise<T> {
    return this.request<T>(ctx, 'POST', path, body, options);
  }

  public async put<T>(ctx: OAuthRockContext, path: string, body?: unknown, options?: RockRequestOptions): Promise<T> {
    return this.request<T>(ctx, 'PUT', path, body, options);
  }

  public async patch<T>(ctx: OAuthRockContext, path: string, body?: unknown, options?: RockRequestOptions): Promise<T> {
    return this.request<T>(ctx, 'PATCH', path, body, options);
  }

  public async delete<T>(ctx: OAuthRockContext, path: string, options?: RockRequestOptions): Promise<T> {
    return this.request<T>(ctx, 'DELETE', path, undefined, options);
  }
}
