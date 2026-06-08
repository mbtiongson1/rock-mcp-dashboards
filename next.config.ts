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
  // The `src/` codebase uses NodeNext-style import specifiers (`./foo.js`
  // resolving to `foo.ts`). Teach webpack to resolve `.js` -> `.ts` so the App
  // Router route handlers can import the existing modules unchanged. Builds and
  // dev run on webpack (see package.json scripts) because Turbopack does not
  // yet support this extension aliasing.
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
};

export default nextConfig;
