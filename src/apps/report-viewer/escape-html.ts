/**
 * Escape the five HTML-significant characters so untrusted strings can be safely
 * interpolated into both element text and double-quoted attribute values.
 *
 * Escaping `"` (and `'`) matters: column names are placed into `data-column="..."`,
 * an attribute context where an unescaped quote allows attribute breakout.
 *
 * Pure and DOM-free so it is unit-testable under Vitest's `environment: 'node'`.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
