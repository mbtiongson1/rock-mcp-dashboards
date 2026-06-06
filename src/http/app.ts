import express from 'express';
import cors from 'cors';
import { createAuthMiddleware } from './oauth.js';
import { resolveMode, ScopeError } from '../mcp/modes.js';
import { RockClientImpl } from '../rock/client.js';
import { RockUserResolver } from '../auth/rock-user-resolver.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { allTools } from '../tools/index.js';
import { registerReportViewerApp } from '../mcp/apps.js';
import { DiscoveryService } from '../discovery/discovery-service.js';
import { InMemoryDatasetStore, RedisDatasetStore, DatasetStore } from '../tools/dataset-store.js';
import { getRockGuideText } from '../mcp/guide-text.js';
import { createRedisClient } from '../rock/redis.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Configure Rock Client and discovery service
  const rockClient = new RockClientImpl({
    baseUrl: process.env.ROCK_PUBLIC_URL || process.env.ROCK_API_URL || '',
    apiKey: process.env.ROCK_API_KEY || '',
  });

  // Initialize Redis and select appropriate stores
  const redis = createRedisClient();
  const discoveryService = new DiscoveryService(rockClient, redis);
  const rockUserResolver = new RockUserResolver(rockClient);
  const datasetStore: DatasetStore = redis
    ? new RedisDatasetStore(redis)
    : new InMemoryDatasetStore();

  // Log which caching mode is active
  if (redis) {
    console.log('[Rock MCP] Using Redis cache for discovery and datasets');
  } else {
    console.log('[Rock MCP] Using in-memory cache (Redis not configured)');
  }

  const authMiddleware = createAuthMiddleware();

  const handleMcpRequest = (endpointKind: 'readonly' | 'readwrite' | 'mcp') => {
    return async (req: express.Request, res: express.Response) => {
      const ctx = req.oauthContext;
      if (!ctx) {
        res.status(500).json({ error: 'OAuth context not initialized' });
        return;
      }

      ctx.endpoint = endpointKind;
      (ctx as any).rockClient = rockClient;
      (ctx as any).discoveryService = discoveryService;
      (ctx as any).datasetStore = datasetStore;

      try {
        // Resolve Rock person
        const resolvedUser = await rockUserResolver.resolve(ctx, {
          subject: ctx.oauth.subject,
          email: ctx.oauth.email,
        });
        ctx.rockUser = resolvedUser;

        // Resolve mode
        const mode = resolveMode(endpointKind, ctx);
        ctx.mode = mode;

        // Create McpServer for this request/session
        const server = new McpServer(
          {
            name: 'rock-mcp',
            version: '1.0.0',
          },
          {
            instructions: getRockGuideText(mode),
          }
        );

        // Register tools dynamically based on Resolved Mode & Scopes
        for (const tool of allTools) {
          const schema = tool.schemaForMode(mode, ctx.scopes);
          if (schema) {
            // Per MCP Apps spec (ext-apps v0.3.0), tools that open an MCP App
            // must advertise the app resource URI via _meta.ui.resourceUri.
            // This tells the host which UI resource to open when the tool completes.
            const baseConfig = {
              title: tool.title,
              description: tool.descriptionForMode(mode),
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
                return await tool.handle(args, extra, ctx) as any;
              }
            );
          }
        }

        // Register App resources
        registerReportViewerApp(server);

        // Run StreamableHTTPServerTransport
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless HTTP POST mode
        });

        res.on('close', () => {
          transport.close().catch(() => {});
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err: any) {
        if (err instanceof ScopeError) {
          res.status(403).json({ error: err.message });
        } else {
          res.status(500).json({ error: err.message || 'Internal server error' });
        }
      }
    };
  };

  app.post('/mcp/readonly', authMiddleware, handleMcpRequest('readonly'));
  app.post('/mcp/readwrite', authMiddleware, handleMcpRequest('readwrite'));
  app.post('/mcp', authMiddleware, handleMcpRequest('mcp'));

  return app;
}
