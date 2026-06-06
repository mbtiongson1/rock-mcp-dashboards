/**
 * Query sanitization helpers for safe string interpolation in Rock RMS queries.
 * Supports both Dynamic LINQ (v2) and OData v3 (v1) query formats.
 */

/**
 * Escape a string for safe embedding in a double-quoted Dynamic LINQ string literal.
 * Escapes backslashes and double quotes.
 * @param value The unescaped string value
 * @returns The escaped value WITHOUT surrounding quotes
 */
export function escapeLinqString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/"/g, '\\"');    // Then escape double quotes
}

/**
 * Quote a string for safe embedding in a Dynamic LINQ string literal.
 * @param value The string value to escape and quote
 * @returns The fully-quoted and escaped literal: "..."
 */
export function quoteLinqString(value: string): string {
  return `"${escapeLinqString(value)}"`;
}

/**
 * Escape a string for safe embedding in an OData v3 single-quoted literal.
 * Single quotes are escaped by doubling them.
 * @param value The unescaped string value
 * @returns The escaped value WITHOUT surrounding quotes
 */
export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");  // Double single quotes
}

/**
 * Quote a string for safe embedding in an OData v3 literal.
 * @param value The string value to escape and quote
 * @returns The fully-quoted and escaped literal: '...'
 */
export function quoteODataString(value: string): string {
  return `'${escapeODataString(value)}'`;
}

/**
 * Validate that a value is a valid GUID and return it unchanged.
 * Throws if the value is not a valid GUID format (with or without hyphens).
 * @param value The potential GUID string
 * @returns The value if valid
 * @throws If the value is not a valid GUID
 */
export function assertValidGuid(value: string): string {
  // GUID format: 8-4-4-4-12 hex digits with hyphens, or 32 hex digits without
  const guidRegex = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

  if (!guidRegex.test(value)) {
    throw new Error(`Invalid GUID format: "${value}"`);
  }

  return value;
}
