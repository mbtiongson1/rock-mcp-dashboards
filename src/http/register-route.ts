import { getAppContext, CreateAppContextOptions } from './app-context.js';
import { jsonCors } from './oauth-validate.js';
import type { Auth0OAuthMetadata } from './oauth.js';

const MAX_CALLBACKS = 50;

/**
 * Validates a redirect URI according to RFC 7591 rules:
 * - Must be a valid URL
 * - Must use HTTPS scheme
 * - EXCEPT: HTTP is allowed for loopback hosts (localhost, 127.0.0.1, [::1])
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') {
    return true;
  }

  if (url.protocol === 'http:') {
    return isLoopbackHost(url.hostname);
  }

  return false;
}

/**
 * Checks if a hostname is a loopback address.
 * Reuse the pattern from src/http/oauth.ts
 */
function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Overrides the registration_endpoint in Auth0 OAuth metadata
 * to point to our own /oauth/register endpoint.
 */
export function overrideRegistrationEndpoint(
  metadata: Auth0OAuthMetadata,
  resourceServerUrl: URL
): Auth0OAuthMetadata {
  const base = resourceServerUrl.href.replace(/\/$/, '');
  return {
    ...metadata,
    registration_endpoint: `${base}/oauth/register`,
  };
}

/**
 * Framework-agnostic handler for POST /oauth/register.
 * Implements RFC 7591 client registration with single-client callback merging.
 *
 * Validates redirect_uris, checks capacity, and calls mergeCallbacks to
 * add them to the shared Auth0 client.
 */
export async function handleRegisterPost(
  request: Request,
  options?: CreateAppContextOptions
): Promise<Response> {
  try {
    const app = await getAppContext(options);

    // Parse request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonCors(
        {
          error: 'invalid_redirect_uri',
          error_description: 'Request body must be valid JSON',
        },
        { status: 400 }
      );
    }

    const bodyObj = body as Record<string, unknown>;

    // Validate redirect_uris field
    const redirectUris = bodyObj.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return jsonCors(
        {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uris must be a non-empty array',
        },
        { status: 400 }
      );
    }

    // Validate each URI is a string
    if (!redirectUris.every((uri): uri is string => typeof uri === 'string')) {
      return jsonCors(
        {
          error: 'invalid_redirect_uri',
          error_description: 'All redirect_uris must be strings',
        },
        { status: 400 }
      );
    }

    // Guard each redirect_uri
    const guardedUris: string[] = [];
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        return jsonCors(
          {
            error: 'invalid_redirect_uri',
            error_description: 'One or more redirect_uris are invalid or disallowed (must be HTTPS, or HTTP only for loopback)',
          },
          { status: 400 }
        );
      }
      guardedUris.push(uri);
    }

    // Check capacity: fetch current callbacks
    const clientInfo = await app.managementClient.getClient();
    const currentCallbackCount = clientInfo.callbacks.length;

    // Compute deduped union size (without actually merging yet)
    const existingSet = new Set(clientInfo.callbacks);
    let unionSize = currentCallbackCount;
    for (const uri of guardedUris) {
      if (!existingSet.has(uri)) {
        unionSize++;
      }
    }

    if (unionSize > MAX_CALLBACKS) {
      return jsonCors(
        {
          error: 'invalid_redirect_uri',
          error_description: `Adding these URIs would exceed the callback limit of ${MAX_CALLBACKS}`,
        },
        { status: 400 }
      );
    }

    // Merge callbacks
    const mergedUris = await app.managementClient.mergeCallbacks(guardedUris);

    // Return RFC 7591 registration response (201)
    return jsonCors(
      {
        client_id: clientInfo.client_id,
        client_name: 'Rock MCP',
        redirect_uris: mergedUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      { status: 201 }
    );
  } catch (err) {
    // Don't expose internal error details in response
    console.error('[register POST] Error:', err);
    return jsonCors(
      {
        error: 'server_error',
      },
      { status: 500 }
    );
  }
}
