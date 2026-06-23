import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../src/apps/report-viewer/escape-html.js';

describe('escapeHtml', () => {
  it('neutralises script tags', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('neutralises img onerror payloads', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;'
    );
  });

  it('escapes double quotes to prevent attribute breakout', () => {
    // This is the case the column-name data-column="..." attribute depends on.
    expect(escapeHtml('x" onmouseover="alert(1)')).toBe(
      'x&quot; onmouseover=&quot;alert(1)'
    );
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#x27;s');
  });

  it('escapes ampersands without double-encoding angle brackets', () => {
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeHtml('John Doe 42')).toBe('John Doe 42');
  });
});
