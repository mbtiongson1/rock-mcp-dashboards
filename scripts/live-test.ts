import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.resolve(process.cwd(), 'scripts/live-test-state.json');
const TOKENS_FILE = path.resolve(process.cwd(), 'scripts/live-test-tokens.json');
const LIVE_MCP_URL = 'https://rock-mcp.favor.church';

interface SavedState {
  clientId: string;
  verifier: string;
  redirectUri: string;
}

interface SavedTokens {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  redirectUri: string;
  expiresAt: number;
}

function parseMcpBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  const dataLine = trimmed.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) {
    throw new Error(`Unexpected MCP response body: ${text}`);
  }
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

async function register() {
  console.log('--- STEP 1: Registering OAuth Client with Live Server ---');
  const redirectUri = 'http://localhost:3000/callback';
  
  const regResponse = await fetch(`${LIVE_MCP_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: 'Antigravity-Live-Test',
    }),
  });

  if (!regResponse.ok) {
    throw new Error(`Registration failed: ${regResponse.status} ${await regResponse.text()}`);
  }

  const regData = await regResponse.json() as { client_id: string };
  const clientId = regData.client_id;
  console.log(`Registered Client ID: ${clientId}`);

  // Generate PKCE
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  // Save state
  const state: SavedState = { clientId, verifier, redirectUri };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');

  // Construct Auth URL
  const authUrl = new URL(`${LIVE_MCP_URL}/oauth/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope', 'read write');
  authUrl.searchParams.set('state', 'live-test-state');

  console.log('\n--- STEP 2: Authorize in Browser ---');
  console.log('Please open the following URL in your browser, log in to Favor Church, and approve the request:');
  console.log('\x1b[36m%s\x1b[0m', authUrl.toString());
  console.log('\nAfter authorization, you will be redirected to a localhost URL (e.g. http://localhost:3000/callback?code=...).');
  console.log('Copy the full redirected URL (or just the "code" query parameter) and run the next step:');
  console.log('pnpm tsx scripts/live-test.ts --exchange "<URL_OR_CODE>"');
}

async function getOrRefreshToken(): Promise<string> {
  if (!fs.existsSync(TOKENS_FILE)) {
    throw new Error(`No saved tokens found at ${TOKENS_FILE}. Run --register and --exchange first.`);
  }

  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')) as SavedTokens;

  // If token is expired or expires in less than 5 minutes, refresh it
  const isExpired = Date.now() > tokens.expiresAt - 5 * 60 * 1000;
  if (isExpired && tokens.refreshToken) {
    console.log('Access token is expired or close to expiration. Refreshing...');
    const refreshResponse = await fetch(`${LIVE_MCP_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: tokens.clientId,
      }).toString(),
    });

    if (!refreshResponse.ok) {
      throw new Error(`Token refresh failed: ${refreshResponse.status} ${await refreshResponse.text()}`);
    }

    const tokenData = await refreshResponse.json() as { access_token: string; refresh_token?: string; expires_in?: number };
    tokens.accessToken = tokenData.access_token;
    if (tokenData.refresh_token) {
      tokens.refreshToken = tokenData.refresh_token;
    }
    tokens.expiresAt = Date.now() + (tokenData.expires_in || 86400) * 1000;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
    console.log('Token refreshed successfully!');
  } else if (isExpired && !tokens.refreshToken) {
    throw new Error('Access token is expired and no refresh token is available. Please re-register.');
  }

  return tokens.accessToken;
}

async function exchange(codeOrUrl: string) {
  console.log('--- STEP 3: Exchanging Code for Access Token ---');
  
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`No state file found at ${STATE_FILE}. Run --register first.`);
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as SavedState;
  
  let code = codeOrUrl;
  if (codeOrUrl.includes('code=')) {
    const urlObj = new URL(codeOrUrl);
    code = urlObj.searchParams.get('code') || codeOrUrl;
  }

  console.log(`Exchanging code: ${code.substring(0, 10)}...`);

  const tokenResponse = await fetch(`${LIVE_MCP_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: state.verifier,
      client_id: state.clientId,
      redirect_uri: state.redirectUri,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }

  const tokenData = await tokenResponse.json() as { access_token: string; refresh_token?: string; scope?: string; expires_in?: number };
  console.log('Token exchange successful!');
  console.log(`Scope granted: ${tokenData.scope || 'N/A'}`);

  // Save tokens to file for persistence
  const savedTokens: SavedTokens = {
    clientId: state.clientId,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    redirectUri: state.redirectUri,
    expiresAt: Date.now() + (tokenData.expires_in || 86400) * 1000,
  };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(savedTokens, null, 2), 'utf-8');
  console.log(`Saved persistent tokens to ${TOKENS_FILE}`);

  // Clean up state file
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {}

  // Run initial test
  await testTools(tokenData.access_token);
}

async function testTools(accessToken: string) {
  console.log('\n--- STEP 4: Calling Live MCP Tools ---');
  
  // Call tools/list
  console.log('1. Fetching tool list...');
  const listResponse = await fetch(`${LIVE_MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });

  if (!listResponse.ok) {
    throw new Error(`tools/list failed: ${listResponse.status} ${await listResponse.text()}`);
  }

  const listData = parseMcpBody(await listResponse.text());
  const tools = listData.result?.tools || [];
  console.log(`Successfully listed ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description.substring(0, 80)}...`);
  }

  // Call rock_usage
  console.log('\n2. Calling tool: rock_usage...');
  const usageResponse = await fetch(`${LIVE_MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'rock_usage',
        arguments: {},
      },
    }),
  });

  if (!usageResponse.ok) {
    throw new Error(`rock_usage failed: ${usageResponse.status} ${await usageResponse.text()}`);
  }

  const usageData = parseMcpBody(await usageResponse.text());
  console.log('rock_usage response:');
  console.log(JSON.stringify(usageData.result || usageData.error, null, 2));

  // Call rock_people find Admin
  console.log('\n3. Calling tool: rock_people (find Admin)...');
  const peopleResponse = await fetch(`${LIVE_MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'rock_people',
        arguments: {
          action: 'find',
          query: 'Admin',
        },
      },
    }),
  });

  if (!peopleResponse.ok) {
    throw new Error(`rock_people failed: ${peopleResponse.status} ${await peopleResponse.text()}`);
  }

  const peopleData = parseMcpBody(await peopleResponse.text());
  console.log('rock_people response (first 200 chars of result):');
  const resultText = JSON.stringify(peopleData.result || peopleData.error, null, 2);
  console.log(resultText.substring(0, 200) + '...');
  
  console.log('\nLive test completed successfully!');
}

async function invokeTool(toolName: string, argsString: string) {
  console.log(`--- Calling Tool: ${toolName} ---`);
  
  const token = await getOrRefreshToken();
  const args = argsString ? JSON.parse(argsString) : {};

  const response = await fetch(`${LIVE_MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Tool invocation failed: ${response.status} ${await response.text()}`);
  }

  const data = parseMcpBody(await response.text());
  console.log(JSON.stringify(data.result || data.error, null, 2));
}

const arg = process.argv[2];
const val = process.argv[3];
const val2 = process.argv[4];

if (arg === '--register') {
  register().catch(console.error);
} else if (arg === '--exchange' && val) {
  exchange(val).catch(console.error);
} else if (arg === '--test-saved') {
  getOrRefreshToken()
    .then(testTools)
    .catch(console.error);
} else if (arg === '--run-tool' && val) {
  invokeTool(val, val2 || '{}').catch(console.error);
} else {
  console.log('Usage:');
  console.log('  pnpm tsx scripts/live-test.ts --register');
  console.log('  pnpm tsx scripts/live-test.ts --exchange "<URL_OR_CODE>"');
  console.log('  pnpm tsx scripts/live-test.ts --test-saved');
  console.log('  pnpm tsx scripts/live-test.ts --run-tool <tool_name> [arguments_json]');
}
