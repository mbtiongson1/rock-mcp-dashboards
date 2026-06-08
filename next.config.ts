import type { NextConfig } from 'next';

const reportViewerIncludes = ['./static/**/*', './dist/apps/**/*'];

const nextConfig: NextConfig = {
  // The MCP route handlers read the report-viewer HTML and the markdown
  // guide files from disk at runtime. Trace those assets into the serverless
  // function bundles so they survive Vercel's file-tracing step.
  outputFileTracingIncludes: {
    '/mcp': reportViewerIncludes,
    '/mcp/readonly': reportViewerIncludes,
    '/mcp/readwrite': reportViewerIncludes,
  },
};

export default nextConfig;
