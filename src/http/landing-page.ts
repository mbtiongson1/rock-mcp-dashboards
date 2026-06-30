/**
 * Escape a string for safe interpolation into HTML element text / attribute
 * contexts. `rockUrl` originates from the attacker-controllable `?url=` /
 * `?server=` query parameter (see app/route.ts), so it MUST be escaped before
 * it is embedded in the response to prevent reflected XSS.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function getLandingPageHtml(options: {
  redisConfigured: boolean;
  rockUrl: string;
  version: string;
  /**
   * Per-request CSP nonce. The page's single <script> carries this nonce so the
   * Content-Security-Policy can use `script-src 'self' 'nonce-…'` instead of
   * 'unsafe-inline'. All behavior is wired via addEventListener in that script
   * (no inline on* handlers), so the strict policy does not break the page.
   */
  nonce: string;
}): string {
  const { redisConfigured, rockUrl, version, nonce } = options;
  const cacheStatus = redisConfigured
    ? '<span class="badge success">Redis Active</span>'
    : '<span class="badge warning">In-Memory Cache</span>';

  const maskedRockUrl = rockUrl
    ? escapeHtml(rockUrl.replace(/(https?:\/\/)([^@]+@)?([^/]+).*/, '$1$3'))
    : 'Not configured';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Favor Church Rock MCP Server</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0b0f19;
      --bg-secondary: #161c2d;
      --bg-tertiary: #1f2a40;
      --accent-color: #4f46e5;
      --accent-hover: #6366f1;
      --accent-glow: rgba(79, 70, 229, 0.15);
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --border-color: #2d3748;
      --success-color: #10b981;
      --success-glow: rgba(16, 185, 129, 0.15);
      --warning-color: #f59e0b;
      --warning-glow: rgba(245, 158, 11, 0.15);
      --card-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', sans-serif;
      background-color: var(--bg-primary);
      background-image: 
        radial-gradient(at 0% 0%, rgba(79, 70, 229, 0.08) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.05) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.6;
    }

    header {
      border-bottom: 1px solid var(--border-color);
      background-color: rgba(22, 28, 45, 0.8);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo-group {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo-img {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      object-fit: cover;
    }

    .logo-text {
      font-family: 'Outfit', sans-serif;
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      color: #ffffff;
      background: linear-gradient(135deg, #ffffff 0%, var(--text-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-secondary);
      background-color: rgba(255, 255, 255, 0.03);
      padding: 0.4rem 0.8rem;
      border-radius: 9999px;
      border: 1px solid var(--border-color);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      background-color: var(--success-color);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--success-color);
      display: inline-block;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      }
      70% {
        transform: scale(1);
        box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
      }
      100% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
      }
    }

    main {
      flex: 1;
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      padding: 3rem 2rem;
      display: flex;
      flex-direction: column;
      gap: 3.5rem;
    }

    .hero {
      text-align: center;
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .hero h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 3rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.15;
      color: #ffffff;
    }

    .hero h1 span {
      background: linear-gradient(135deg, #a5b4fc 0%, var(--accent-color) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .hero p {
      font-size: 1.15rem;
      color: var(--text-secondary);
      max-width: 600px;
      margin: 0 auto;
    }

    .metadata-grid {
      display: flex;
      justify-content: center;
      gap: 1.5rem;
      margin-top: 1.5rem;
      flex-wrap: wrap;
    }

    .metadata-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      padding: 0.5rem 1rem;
      border-radius: 8px;
    }

    .metadata-label {
      color: var(--text-secondary);
    }

    .metadata-value {
      font-weight: 600;
      color: #ffffff;
    }

    .badge {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      font-size: 0.75rem;
      font-weight: 700;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge.success {
      background-color: var(--success-glow);
      color: var(--success-color);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .badge.warning {
      background-color: var(--warning-glow);
      color: var(--warning-color);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .section-title {
      font-family: 'Outfit', sans-serif;
      font-size: 1.75rem;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .section-subtitle {
      font-size: 1rem;
      color: var(--text-secondary);
      margin-bottom: 2rem;
    }

    .endpoints-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1.5rem;
    }

    .endpoint-card {
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 2rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
      position: relative;
      overflow: hidden;
      box-shadow: var(--card-shadow);
    }

    .endpoint-card:hover {
      transform: translateY(-4px);
      border-color: var(--accent-color);
      box-shadow: 0 12px 20px -8px var(--accent-glow);
    }

    .endpoint-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 4px;
      background: linear-gradient(90deg, var(--accent-color), var(--accent-hover));
      opacity: 0;
      transition: opacity 0.2s;
    }

    .endpoint-card:hover::before {
      opacity: 1;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .endpoint-mode {
      font-family: 'Outfit', sans-serif;
      font-size: 1.25rem;
      font-weight: 600;
      color: #ffffff;
    }

    .method-badge {
      font-family: monospace;
      font-weight: 700;
      font-size: 0.8rem;
      background-color: rgba(79, 70, 229, 0.1);
      color: var(--accent-hover);
      border: 1px solid rgba(79, 70, 229, 0.2);
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
    }

    .endpoint-path-container {
      background-color: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 0.75rem 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }

    .endpoint-path {
      font-family: monospace;
      font-size: 0.9rem;
      color: #ffffff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .btn-copy {
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.25rem;
      border-radius: 4px;
      transition: color 0.2s, background-color 0.2s;
    }

    .btn-copy:hover {
      color: #ffffff;
      background-color: rgba(255, 255, 255, 0.05);
    }

    .endpoint-desc {
      font-size: 0.95rem;
      color: var(--text-secondary);
      flex: 1;
    }

    .endpoint-meta {
      border-top: 1px solid var(--border-color);
      padding-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      font-size: 0.85rem;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
    }

    .meta-label {
      color: var(--text-secondary);
    }

    .meta-val {
      font-weight: 500;
      color: #ffffff;
    }

    .guide-section {
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: var(--card-shadow);
    }

    .tabs-nav {
      display: flex;
      gap: 0.5rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 1rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }

    .tab-btn {
      background: none;
      border: none;
      color: var(--text-secondary);
      font-family: 'Outfit', sans-serif;
      font-size: 1rem;
      font-weight: 600;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.2s, background-color 0.2s;
    }

    .tab-btn:hover {
      color: #ffffff;
      background-color: rgba(255, 255, 255, 0.03);
    }

    .tab-btn.active {
      color: #ffffff;
      background-color: var(--accent-color);
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
      animation: fadeIn 0.3s ease-in-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    pre {
      background-color: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1.25rem;
      overflow-x: auto;
      position: relative;
      margin: 1rem 0;
    }

    code {
      font-family: monospace;
      font-size: 0.9rem;
      color: #e2e8f0;
    }

    .pre-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
      font-size: 0.8rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .guide-text {
      font-size: 0.95rem;
      color: var(--text-secondary);
      margin-bottom: 1.5rem;
    }

    .guide-text p {
      margin-bottom: 0.75rem;
    }

    .guide-text ul {
      margin-left: 1.5rem;
      margin-bottom: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    footer {
      border-top: 1px solid var(--border-color);
      padding: 2rem;
      text-align: center;
      font-size: 0.85rem;
      color: var(--text-secondary);
      background-color: rgba(11, 15, 25, 0.5);
    }

    .toast-container {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .toast {
      background-color: var(--bg-tertiary);
      border: 1px solid var(--accent-color);
      color: #ffffff;
      padding: 0.75rem 1.25rem;
      border-radius: 8px;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.9rem;
      animation: slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .github-link {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-primary);
      background-color: rgba(255, 255, 255, 0.05);
      padding: 0.4rem 0.8rem;
      border-radius: 9999px;
      border: 1px solid var(--border-color);
      text-decoration: none;
      transition: background-color 0.2s, border-color 0.2s;
    }

    .github-link:hover {
      background-color: rgba(255, 255, 255, 0.1);
      border-color: var(--accent-color);
    }

    .btn-primary-link {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background-color: var(--accent-color);
      color: #ffffff;
      padding: 0.6rem 1.2rem;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.95rem;
      transition: background-color 0.2s, box-shadow 0.2s;
      border: 1px solid transparent;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }

    .btn-primary-link:hover {
      background-color: var(--accent-hover);
      box-shadow: 0 10px 15px -3px var(--accent-glow), 0 4px 6px -2px var(--accent-glow);
    }

    .info-block {
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 2rem;
      box-shadow: var(--card-shadow);
    }

    .feature-list {
      list-style-type: none;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin-top: 1rem;
    }

    .feature-list li {
      font-size: 0.95rem;
      color: var(--text-secondary);
      position: relative;
      padding-left: 1.5rem;
      line-height: 1.5;
      text-align: left;
    }

    .feature-list li::before {
      content: "•";
      color: var(--accent-hover);
      font-weight: bold;
      font-size: 1.25rem;
      position: absolute;
      left: 0;
      top: -2px;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-container">
      <div class="logo-group">
        <img src="/static/icon.png" alt="Favor Church Logo" class="logo-img" id="logo-img">
        <span class="logo-text">Favor Church Rock MCP</span>
      </div>
      <div style="display: flex; align-items: center; gap: 1rem;">
        <a href="https://github.com/favorchurch/rock-mcp" target="_blank" rel="noopener noreferrer" class="github-link">
          <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
          GitHub
        </a>
        <div class="status-indicator">
          <span class="status-dot"></span>
          <span>Online</span>
        </div>
      </div>
    </div>
  </header>

  <main>
    <section class="hero">
      <h1>Model Context Protocol <span>Gateway</span></h1>
      <p>Secure, low-token action-router interface for Rock RMS v17.7. Connects Claude, Cursor, and other AI clients to church operations.</p>
      
      <div style="margin-top: 0.5rem; margin-bottom: 1rem; display: flex; justify-content: center; gap: 1rem;">
        <a href="https://github.com/favorchurch/rock-mcp" target="_blank" rel="noopener noreferrer" class="btn-primary-link">
          <svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
          View on GitHub
        </a>
      </div>

      <div class="metadata-grid">
        <div class="metadata-item">
          <span class="metadata-label">Version:</span>
          <span class="metadata-value">${version}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Cache:</span>
          <span class="metadata-value">${cacheStatus}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Rock Target:</span>
          <span class="metadata-value">${maskedRockUrl}</span>
        </div>
      </div>
    </section>

    <section>
      <div class="section-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-hover)"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
        <span>MCP Connections</span>
      </div>
      <p class="section-subtitle">Exposes OAuth-protected endpoints tailored to different user scopes and security levels.</p>

      <div class="endpoints-grid">
        <div class="endpoint-card">
          <div class="card-header">
            <span class="endpoint-mode">Smart Gateway</span>
            <span class="method-badge">POST</span>
          </div>
          <div class="endpoint-desc">
            Detects user status automatically. Upgrades to readwrite mode for admins with write scopes; defaults to readonly.
          </div>
          <div class="endpoint-path-container">
            <span class="endpoint-path" id="url-mcp">https://rock-mcp.favor.church/mcp</span>
            <button class="btn-copy" data-copy="url-mcp" title="Copy URL">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
          <div class="endpoint-meta">
            <div class="meta-row">
              <span class="meta-label">Min Scope</span>
              <span class="meta-val">read</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Write Access</span>
              <span class="meta-val">RSR Admins Only</span>
            </div>
          </div>
        </div>

        <div class="endpoint-card">
          <div class="card-header">
            <span class="endpoint-mode">Read-Only Gateway</span>
            <span class="method-badge">POST</span>
          </div>
          <div class="endpoint-desc">
            Enforces a read-only context. Safe default for standard operations. Ideal for broad, lower-risk LLM access.
          </div>
          <div class="endpoint-path-container">
            <span class="endpoint-path" id="url-readonly">https://rock-mcp.favor.church/mcp/readonly</span>
            <button class="btn-copy" data-copy="url-readonly" title="Copy URL">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
          <div class="endpoint-meta">
            <div class="meta-row">
              <span class="meta-label">Min Scope</span>
              <span class="meta-val">read</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Write Access</span>
              <span class="meta-val">Disabled</span>
            </div>
          </div>
        </div>

        <div class="endpoint-card">
          <div class="card-header">
            <span class="endpoint-mode">Read-Write Gateway</span>
            <span class="method-badge">POST</span>
          </div>
          <div class="endpoint-desc">
            Explicitly registers read and write tools. Requires OAuth client write credentials. Runs operations as the user.
          </div>
          <div class="endpoint-path-container">
            <span class="endpoint-path" id="url-readwrite">https://rock-mcp.favor.church/mcp/readwrite</span>
            <button class="btn-copy" data-copy="url-readwrite" title="Copy URL">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
          <div class="endpoint-meta">
            <div class="meta-row">
              <span class="meta-label">Min Scope</span>
              <span class="meta-val">read + write</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">Write Access</span>
              <span class="meta-val">Enabled (Authorized)</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="features-security-section">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2rem;">
        <!-- Key Features Column -->
        <div class="info-block">
          <div class="section-title">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-hover)"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            <span>Key Features</span>
          </div>
          <ul class="feature-list">
            <li><strong>OAuth 2.0 Protection:</strong> Secure, PKCE-based authorization flow with Auth0 JWT token verification via JWKS.</li>
            <li><strong>Built-in React Report Viewer:</strong> Real-time interactive reporting directly inside Cursor/Claude using an embedded MCP Web App.</li>
            <li><strong>Church-Tailored Tools:</strong> Deep integration with Rock RMS group types, campuses, connection requests, and serving rosters.</li>
            <li><strong>Low-Token Action Routing:</strong> Normalizes and formats queries to minimize context window consumption on LLM calls.</li>
          </ul>
        </div>

        <!-- Security & Safety Standards Column -->
        <div class="info-block">
          <div class="section-title">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--success-color)"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <span>Security & PII Rules</span>
          </div>
          <ul class="feature-list">
            <li><strong>Fail-Closed Modes:</strong> Reverts automatically to read-only mode if permissions or user mapping fails.</li>
            <li><strong>Dry-Run by Default:</strong> All updates default to dry-run mode and require explicit confirmation via <code>commit: true</code>.</li>
            <li><strong>Write Auditing:</strong> Every write, patch, or delete operation requires a mandatory human-readable reason string.</li>
            <li><strong>Privacy Filters:</strong> Automatically strips sensitive PII (emails, phone numbers, addresses) unless explicitly requested.</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="guide-section">
      <div class="section-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-hover)"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
        <span>Integration Guide</span>
      </div>
      
      <div class="tabs-nav">
        <button class="tab-btn active" data-tab="tab-claude">Claude Desktop</button>
        <button class="tab-btn" data-tab="tab-cursor">Cursor IDE</button>
        <button class="tab-btn" data-tab="tab-auth">Authentication</button>
      </div>

      <div id="tab-claude" class="tab-content active">
        <div class="guide-text">
          <p>To register the Favor Church Rock MCP server in your Claude Desktop app, point the client at the MCP URL. Claude will discover the OAuth metadata and prompt you to sign in with Rock/Auth0.</p>
          <ul>
            <li><strong>MacOS:</strong> <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
            <li><strong>Windows:</strong> <code>%APPDATA%\\Claude\\claude_desktop_config.json</code></li>
          </ul>
        </div>
        <div class="pre-header">claude_desktop_config.json</div>
        <pre><code>{
  "mcpServers": {
    "rock-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/sdk",
        "connect",
        "https://rock-mcp.favor.church/mcp"
      ]
    }
  }
}</code></pre>
      </div>

      <div id="tab-cursor" class="tab-content">
        <div class="guide-text">
          <p>Cursor can connect to the remote MCP endpoint and complete the OAuth login in-browser through Rock/Auth0.</p>
          <p>Use the Smart Gateway URL for normal access:</p>
          <ol style="margin-left: 1.5rem; margin-bottom: 1rem; display: flex; flex-direction: column; gap: 0.5rem;">
            <li>Open Cursor Settings > Features > MCP.</li>
            <li>Click <strong>+ Add New MCP Server</strong>.</li>
            <li>Fill in:
              <ul>
                <li><strong>Name:</strong> <code>rock-mcp</code></li>
                <li><strong>Type:</strong> <code>command</code></li>
                <li><strong>Command:</strong> <code>npx -y @modelcontextprotocol/sdk connect https://rock-mcp.favor.church/mcp</code></li>
              </ul>
            </li>
          </ol>
        </div>
      </div>

      <div id="tab-auth" class="tab-content">
        <div class="guide-text">
          <p>All MCP endpoints use OAuth Protected Resource metadata and Auth0 authorization server discovery. Configure your client with the <code>/mcp</code> URL, then complete the Rock/Auth0 login flow when prompted.</p>
          <p><strong>OAuth discovery:</strong></p>
          <ul>
            <li><code>/.well-known/oauth-protected-resource</code> advertises this MCP resource and supported scopes.</li>
            <li><code>/.well-known/oauth-authorization-server</code> mirrors the Auth0 metadata used for login and token issuance.</li>
          </ul>
          <p>Access tokens issued by the login flow must contain at least the <code>read</code> scope. To perform updates/writes via <code>/mcp/readwrite</code> or <code>/mcp</code>, the signed-in user also needs the <code>write</code> scope and Rock authorization for the targeted entity.</p>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <p>&copy; 2026 Favor Church Manila. All rights reserved.</p>
  </footer>

  <div class="toast-container" id="toast-container"></div>

  <script nonce="${nonce}">
    // Copy URL function
    function copyText(elementId) {
      const el = document.getElementById(elementId);
      if (!el) return;

      // Update absolute URL if accessed from another host
      const finalUrl = el.innerText.replace('https://rock-mcp.favor.church', window.location.origin);

      navigator.clipboard.writeText(finalUrl).then(() => {
        showToast('Copied to clipboard!');
      }).catch(err => {
        console.error('Failed to copy: ', err);
      });
    }

    // Switch Tabs function (receives the clicked button element)
    function switchTab(button, tabId) {
      // Hide all tabs
      const contents = document.querySelectorAll('.tab-content');
      contents.forEach(content => content.classList.remove('active'));

      // Deactivate all buttons
      const buttons = document.querySelectorAll('.tab-btn');
      buttons.forEach(btn => btn.classList.remove('active'));

      // Show targeted tab
      const target = document.getElementById(tabId);
      if (target) target.classList.add('active');
      button.classList.add('active');
    }

    // Toast notification function
    function showToast(message) {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = \`
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        <span>\${message}</span>
      \`;
      
      container.appendChild(toast);
      
      // Remove toast after 3s
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'opacity 0.3s, transform 0.3s';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    document.addEventListener('DOMContentLoaded', () => {
      // Update copyable URLs dynamically with current hostname
      ['url-mcp', 'url-readonly', 'url-readwrite'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.innerText = el.innerText.replace('https://rock-mcp.favor.church', window.location.origin);
        }
      });

      // Wire copy buttons (CSP-safe: no inline on* handlers).
      document.querySelectorAll('.btn-copy[data-copy]').forEach(btn => {
        btn.addEventListener('click', () => copyText(btn.getAttribute('data-copy')));
      });

      // Wire integration-guide tabs.
      document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn, btn.getAttribute('data-tab')));
      });

      // Logo fallback (replaces the former inline onerror handler).
      const logo = document.getElementById('logo-img');
      if (logo) {
        logo.addEventListener('error', () => { logo.style.display = 'none'; });
      }
    });
  </script>
</body>
</html>
`;
}
