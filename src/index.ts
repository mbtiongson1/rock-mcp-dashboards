import { createApp } from './http/app.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { allTools } from './tools/index.js';
import { registerReportViewerApp } from './mcp/apps.js';
import { RockClientImpl } from './rock/client.js';
import { DiscoveryService } from './discovery/discovery-service.js';
import { OAuthRockContext } from './http/oauth.js';
import { InMemoryDatasetStore } from './tools/dataset-store.js';
import { getRockGuideText } from './mcp/guide-text.js';

// Load environment variables
try {
  process.loadEnvFile();
} catch {
  // Ignore if already loaded
}

const isStdio = process.argv.includes('--stdio');

if (isStdio) {
  console.error('Starting Rock MCP Server in stdio mode...');

  const rockClient = new RockClientImpl({
    baseUrl: process.env.ROCK_PUBLIC_URL || process.env.ROCK_API_URL || '',
    apiKey: process.env.ROCK_API_KEY || '',
  });

  const discoveryService = new DiscoveryService(rockClient);
  const datasetStore = new InMemoryDatasetStore();

  // Mock dev context with admin rights for local inspect/debugging
  const devCtx: OAuthRockContext = {
    endpoint: 'mcp',
    mode: 'readwrite',
    scopes: new Set(['read', 'write']),
    oauth: {
      subject: 'local-dev-user',
      email: 'admin@example.com',
      accessTokenHash: '',
    },
    rockUser: {
      personId: 1,
      isRsrAdmin: true,
    },
    request: {
      sessionId: 'local-session',
      requestId: 'local-request',
    },
  };

  (devCtx as any).rockClient = rockClient;
  (devCtx as any).discoveryService = discoveryService;
  (devCtx as any).datasetStore = datasetStore;

  const server = new McpServer(
    {
      name: 'rock-mcp',
      version: '1.0.0',
    },
    {
      instructions: getRockGuideText('readwrite'),
    }
  );

  // Register all tools in readwrite mode for developer accessibility
  for (const tool of allTools) {
    const schema = tool.schemaForMode('readwrite', devCtx.scopes);
    if (schema) {
      // Per MCP Apps spec (ext-apps v0.3.0), tools that open an MCP App
      // must advertise the app resource URI via _meta.ui.resourceUri.
      const baseConfig = {
        title: tool.title,
        description: tool.descriptionForMode('readwrite'),
        inputSchema: schema,
      };
      const config = tool.appResourceUri
        ? {
            ...baseConfig,
            _meta: {
              ui: {
                resourceUri: tool.appResourceUri,
              },
            },
          }
        : baseConfig;

      server.registerTool(
        tool.name,
        config,
        async (args: any, extra: any) => {
          return await tool.handle(args, extra, devCtx) as any;
        }
      );
    }
  }

  registerReportViewerApp(server);

  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error('Stdio server failed:', err);
    process.exit(1);
  });
} else {
  const app = createApp();
  const port = process.env.PORT || 8787;

  app.listen(port, () => {
    console.log(`Rock MCP Server listening over HTTP on port ${port}`);
    console.log(`Endpoints:`);
    console.log(`  POST http://localhost:${port}/mcp`);
    console.log(`  POST http://localhost:${port}/mcp/readonly`);
    console.log(`  POST http://localhost:${port}/mcp/readwrite`);
  });
}
