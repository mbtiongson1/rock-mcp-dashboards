import { describe, it, expect } from 'vitest';
import { getLandingPageHtml } from '../../src/http/landing-page.js';

const NONCE = 'test-nonce-abc123';

const render = (over: Partial<{ redisConfigured: boolean; rockUrl: string; version: string; nonce: string }> = {}) =>
  getLandingPageHtml({
    redisConfigured: true,
    rockUrl: 'https://rock.favor.church',
    version: '1.0.0',
    nonce: NONCE,
    ...over,
  });

describe('getLandingPageHtml', () => {
  it('renders the configured Rock target without injecting markup', () => {
    expect(render()).toContain('https://rock.favor.church');
  });

  // app/route.ts reflects the attacker-controlled ?url= / ?server= query
  // parameter into `rockUrl`, which is interpolated into the HTML response.
  // The masked value must be HTML-escaped so a hostile value cannot break out
  // of the element and inject script-bearing markup (reflected XSS).
  it('HTML-escapes a hostile Rock URL so no live tag is injected', () => {
    const html = render({ rockUrl: 'https://x<img src=x onerror=alert(document.domain)>' });
    expect(html).not.toContain('<img src=x onerror=alert(document.domain)>');
    expect(html).toContain('&lt;img src=x onerror=alert(document.domain)&gt;');
  });

  // CSP-readiness: the policy uses script-src 'nonce-…' (no 'unsafe-inline'),
  // so the page's only <script> must carry the nonce and there must be NO
  // inline event-handler attributes anywhere.
  it('puts the CSP nonce on its script tag', () => {
    expect(render()).toContain(`<script nonce="${NONCE}">`);
  });

  it('contains no inline event-handler attributes (CSP strict-script safe)', () => {
    const html = render();
    expect(html).not.toMatch(/\son(click|error|load|mouseover|submit)\s*=/i);
  });

  it('wires interactive controls via data attributes instead of inline handlers', () => {
    const html = render();
    expect(html).toContain('data-copy="url-mcp"');
    expect(html).toContain('data-tab="tab-claude"');
    expect(html).toContain('id="logo-img"');
  });
});
