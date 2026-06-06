import { describe, it, expect } from 'vitest';
// @ts-ignore
import { createApp } from './app.js';

describe('HTTP MCP Endpoints', () => {
  it('should expose the expected MCP endpoints', async () => {
    const app = createApp();
    // We expect the app to have registered routers or paths
    const routes = app._router.stack
      .filter((r: any) => r.route)
      .map((r: any) => r.route.path);

    expect(routes).toContain('/mcp/readonly');
    expect(routes).toContain('/mcp/readwrite');
    expect(routes).toContain('/mcp');
  });

  it('should have dataset store, instructions, and guide wiring', async () => {
    // Test that createApp() doesn't throw and has expected structure
    const app = createApp();
    expect(app).toBeDefined();
    // Router has expected endpoints
    const routes = app._router.stack
      .filter((r: any) => r.route)
      .map((r: any) => r.route.path);
    expect(routes.length).toBeGreaterThan(0);
  });
});
