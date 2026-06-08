import { getLandingPageHtml } from '@/src/http/landing-page';
import { createRedisClient } from '@/src/rock/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const redisConfigured = !!createRedisClient();
  const rockUrl = process.env.ROCK_PUBLIC_URL || process.env.ROCK_API_URL || '';
  const html = getLandingPageHtml({ redisConfigured, rockUrl, version: '1.0.0' });
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
