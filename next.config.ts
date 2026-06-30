import type { NextConfig } from 'next';

const reportViewerIncludes = ['./static/**/*', './dist/apps/**/*'];

const nextConfig: NextConfig = {
  // The MCP route handlers read the report-viewer HTML and the markdown
  // guide files from disk at runtime — including the searchable wiki under
  // `static/mcp-guides/wiki/` (loaded by src/mcp/wiki/wiki-store.ts). The
  // `./static/**/*` glob below recursively covers that directory; keep it that
  // way so wiki topics survive Vercel's file-tracing step.
  outputFileTracingIncludes: {
    '/mcp': reportViewerIncludes,
    '/mcp/readonly': reportViewerIncludes,
    '/mcp/readwrite': reportViewerIncludes,
  },
  // Baseline security headers applied to every response. These are static and
  // safe for both the HTML landing page and the JSON MCP/OAuth endpoints. The
  // landing page additionally sets a per-request, nonce-based
  // Content-Security-Policy in app/route.ts (a nonce can't be expressed here).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
        ],
      },
    ];
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
