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
import { InMemoryDatasetStore } from '../tools/dataset-store.js';
import { getRockGuideText } from '../mcp/guide-text.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Configure Rock Client and discovery service
  const rockClient = new RockClientImpl({
    baseUrl: process.env.ROCK_PUBLIC_URL || process.env.ROCK_API_URL || '',
    apiKey: process.env.ROCK_API_KEY || '',
  });

  const discoveryService = new DiscoveryService(rockClient);
  const rockUserResolver = new RockUserResolver(rockClient);
  const datasetStore = new InMemoryDatasetStore();

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
            server.registerTool(
              tool.name,
              {
                title: tool.title,
                description: tool.descriptionForMode(mode),
                inputSchema: schema,
              },
              async (args, extra) => {
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
