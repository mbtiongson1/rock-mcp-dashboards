/**
 * Per-request Rock server override (`?server=` query parameter on the MCP
 * endpoints, e.g. /mcp?server=rock-preview.favor.church).
 *
 * SECURITY: the per-user RockClient forwards the caller's bearer token to the
 * Rock base URL, so an unvalidated override would leak credentials to an
 * arbitrary host (SSRF + token exfiltration). Overrides are therefore limited
 * to: the configured default host, hosts explicitly listed in the
 * ROCK_ALLOWED_SERVERS env var (comma-separated), and — for backwards
 * compatibility with existing clients — any host under the legacy
 * `favor.church` domain. HTTPS is always enforced.
 *
 * Note: there is intentionally NO implicit "trust the default host's parent
 * domain" rule. Pointing the deployment at a Rock host on some other domain
 * does NOT silently trust that whole domain; add explicit hosts to
 * ROCK_ALLOWED_SERVERS instead.
 */

/**
 * Legacy backwards-compatibility allowance. Older clients pass favor.church Rock
 * hosts (e.g. rock-preview.favor.church) via ?server=/?url=, so any host under
 * this domain stays allowed regardless of the configured default host or
 * ROCK_ALLOWED_SERVERS. Remove this once all clients use explicit hosts.
 */
function getLegacyAllowedDomain(): string {
  return process.env.LEGACY_ALLOWED_DOMAIN !== undefined
    ? process.env.LEGACY_ALLOWED_DOMAIN.trim()
    : 'favor.church';
}

/** True for the legacy domain apex and any subdomain (with a dot boundary). */
function isLegacyAllowedHost(host: string): boolean {
  const legacyDomain = getLegacyAllowedDomain();
  if (!legacyDomain) return false;
  return host === legacyDomain || host.endsWith(`.${legacyDomain}`);
}

export type ServerOverrideResult =
  | { ok: true; baseUrl: string; host: string }
  | { ok: false; error: string };

function normalizeHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // Accept either a bare host or a full URL; always coerce to https.
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.port) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.hostname;
}

export function resolveServerOverride(
  serverParam: string,
  defaultBaseUrl: string,
  allowedServersEnv?: string
): ServerOverrideResult {
  const host = normalizeHost(serverParam);
  if (!host) {
    return {
      ok: false,
      error: `Invalid server parameter '${serverParam}'. Pass a bare HTTPS hostname, e.g. ?server=rock-preview.favor.church`,
    };
  }

  let defaultHost: string | null = null;
  try {
    defaultHost = new URL(defaultBaseUrl).hostname.toLowerCase();
  } catch {
    // No valid default base configured; only the env allowlist can permit overrides.
  }

  const extraAllowed = (allowedServersEnv || '')
    .split(',')
    .map((h) => normalizeHost(h))
    .filter((h): h is string => !!h);

  const allowed =
    (defaultHost && host === defaultHost) ||
    extraAllowed.includes(host) ||
    isLegacyAllowedHost(host);

  if (!allowed) {
    const legacyDomain = getLegacyAllowedDomain();
    const allowedList = [
      defaultHost,
      legacyDomain ? `*.${legacyDomain}` : null,
      ...extraAllowed,
    ].filter((h): h is string | null => !!h);

    return {
      ok: false,
      error: `Server '${host}' is not an allowed Rock host. Allowed: ${allowedList.join(', ')}.`,
    };
  }

  return { ok: true, baseUrl: `https://${host}`, host };
}
