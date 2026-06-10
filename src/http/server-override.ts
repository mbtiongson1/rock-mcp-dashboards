/**
 * Per-request Rock server override (`?server=` query parameter on the MCP
 * endpoints, e.g. /mcp?server=rock-preview.favor.church).
 *
 * SECURITY: the per-user RockClient forwards the caller's bearer token to the
 * Rock base URL, so an unvalidated override would leak credentials to an
 * arbitrary host (SSRF + token exfiltration). Overrides are therefore limited
 * to: the configured default host, sibling hosts on the same parent domain
 * (e.g. *.favor.church when the default is rock.favor.church), and hosts
 * explicitly listed in the ROCK_ALLOWED_SERVERS env var (comma-separated).
 * HTTPS is always enforced.
 */

export type ServerOverrideResult =
  | { ok: true; baseUrl: string; host: string }
  | { ok: false; error: string };

/** Last two DNS labels of a host, e.g. 'rock.favor.church' → 'favor.church'. */
function parentDomain(host: string): string | null {
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  return labels.slice(-2).join('.');
}

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

  const parent = defaultHost ? parentDomain(defaultHost) : null;
  const allowed =
    (defaultHost && host === defaultHost) ||
    (parent && (host === parent || host.endsWith(`.${parent}`))) ||
    extraAllowed.includes(host);

  if (!allowed) {
    return {
      ok: false,
      error: `Server '${host}' is not an allowed Rock host. Allowed: ${[
        defaultHost,
        parent ? `*.${parent}` : null,
        ...extraAllowed,
      ].filter(Boolean).join(', ')}.`,
    };
  }

  return { ok: true, baseUrl: `https://${host}`, host };
}
