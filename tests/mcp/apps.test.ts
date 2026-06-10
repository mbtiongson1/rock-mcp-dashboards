import { describe, it, expect, vi } from 'vitest';
// @ts-ignore
import { registerReportViewerApp, REPORT_VIEWER_URI } from '../../src/mcp/apps.js';
// @ts-ignore
import { rockReportTool } from '../../src/tools/rock-report.js';
// @ts-ignore
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('MCP App Registration', () => {
  it('should attempt to register the report viewer resource with the McpServer', () => {
    const mockServer = {
      registerResource: vi.fn(),
    };

    registerReportViewerApp(mockServer as any);

    expect(mockServer.registerResource).toHaveBeenCalledWith(
      expect.stringContaining('report-viewer'),
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('rock_report tool should advertise the report viewer app resource URI', () => {
    expect(rockReportTool.appResourceUri).toBe(REPORT_VIEWER_URI);
  });

  it('REPORT_VIEWER_URI should be properly defined', () => {
    expect(REPORT_VIEWER_URI).toBe('ui://rock/report-viewer.html');
  });
});
