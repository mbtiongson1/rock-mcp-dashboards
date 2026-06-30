import * as crypto from 'crypto';
import { getLandingPageHtml } from '@/src/http/landing-page';
import { createRedisClient } from '@/src/rock/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const redisConfigured = !!createRedisClient();
  const { searchParams } = new URL(request.url);
  const queryUrl = searchParams.get('url') || searchParams.get('server');

  let rockUrl = process.env.ROCK_PUBLIC_URL || process.env.ROCK_API_URL || '';
  if (queryUrl) {
    const trimmed = queryUrl.trim();
    rockUrl = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  }

  // Per-request CSP nonce: the page's only <script> carries it, so the policy
  // can forbid arbitrary inline script. Styles stay 'unsafe-inline' (the page
  // uses a large inline <style>; style injection is far lower risk than script)
  // and Google Fonts are explicitly allowed.
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');

  const html = getLandingPageHtml({ redisConfigured, rockUrl, version: '1.0.0', nonce });
  // The baseline headers (nosniff, frame-options, referrer-policy, HSTS,
  // permissions-policy) are applied globally in next.config.ts; only the
  // nonce-based CSP is per-request and set here.
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
    },
  });
}
