import { Redis } from '@upstash/redis';
import * as fs from 'fs';
import * as path from 'path';

// Parse .env.production manually
try {
  const envPath = path.resolve(process.cwd(), '.env.production');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const firstEquals = trimmed.indexOf('=');
    if (firstEquals !== -1) {
      const key = trimmed.substring(0, firstEquals).trim();
      let val = trimmed.substring(firstEquals + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.substring(1, val.length - 1);
      }
      process.env[key] = val;
    }
  }
} catch (err) {
  console.warn('Could not parse .env.production manually:', err);
}

async function main() {
  const url = process.env.UPSTASH_KV_REST_API_URL;
  const token = process.env.UPSTASH_KV_REST_API_TOKEN;
  const prefix = process.env.ROCK_MCP_REDIS_PREFIX || 'rock-mcp:prod:';

  console.log(`Connecting to Upstash Redis at: ${url}`);
  console.log(`Using prefix: ${prefix}`);

  if (!url || !token) {
    console.error('Error: UPSTASH_KV_REST_API_URL or UPSTASH_KV_REST_API_TOKEN is not set.');
    process.exit(1);
  }

  const redis = new Redis({ url, token });

  // Scan for keys with the prefix
  try {
    const keys = await redis.keys(`${prefix}*`);
    console.log(`\nFound ${keys.length} keys:`);
    for (const key of keys) {
      const type = await redis.type(key);
      const ttl = await redis.ttl(key);
      let valPreview = '';
      
      try {
        const val = await redis.get(key);
        valPreview = typeof val === 'object' ? JSON.stringify(val) : String(val);
      } catch (err) {
        valPreview = `[Failed to fetch/parse value: ${err}]`;
      }

      console.log(`- ${key} (${type}, TTL: ${ttl}s): ${valPreview.substring(0, 150)}`);
    }
  } catch (error) {
    console.error('Failed to query Redis:', error);
  }
}

main().catch(console.error);
