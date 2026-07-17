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
 * Decode the small set of HTML entities that MCP clients sometimes send inside a
 * `where` clause (e.g. a client that HTML-escapes double quotes to `&quot;`).
 * Left un-decoded they leak into the OData `$filter` and Rock 400s with
 * "character '&' is not valid".
 */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // last, so decoded entities are not themselves re-decoded
}

/**
 * Translate a Dynamic-LINQ-style `where` clause (as accepted by Rock's v2 search)
 * into an OData v3 `$filter` expression for the v1 REST fallback.
 *
 * Rock's v1 API speaks WCF Data Services OData v3, which differs from LINQ in
 * three ways this handles: relational operators are word tokens
 * (`gt`/`lt`/`ge`/`le`, not `>`/`<`/`>=`/`<=`); string matching uses the
 * `substringof`/`startswith`/`endswith` functions rather than `.Contains()` etc.;
 * and string literals are single-quoted, not double-quoted.
 *
 * This is a best-effort, regex-based translation for the common filter shapes —
 * it does NOT parse the expression, so an operator or entity that appears inside
 * a quoted string literal may be rewritten too. Keep `where` clauses simple.
 */
export function linqToOData(where?: string): string {
  if (!where) return '';
  let odata = decodeHtmlEntities(where);

  // Method calls -> OData functions. Done before quote conversion so the
  // argument's double quotes are normalized to single quotes by the step below.
  // The field may be a dotted navigation path (e.g. `Person.NickName`).
  odata = odata.replace(
    /([A-Za-z_][\w.]*)\.Contains\(([^)]*)\)/g,
    (_m, field, arg) => `substringof(${arg.trim()}, ${field}) eq true`
  );
  odata = odata.replace(
    /([A-Za-z_][\w.]*)\.StartsWith\(([^)]*)\)/g,
    (_m, field, arg) => `startswith(${field}, ${arg.trim()}) eq true`
  );
  odata = odata.replace(
    /([A-Za-z_][\w.]*)\.EndsWith\(([^)]*)\)/g,
    (_m, field, arg) => `endswith(${field}, ${arg.trim()}) eq true`
  );

  // Equality operators.
  odata = odata.replace(/\s*==\s*/g, ' eq ');
  odata = odata.replace(/\s*!=\s*/g, ' ne ');

  // Relational operators. Two-char forms first so `>=`/`<=` are not clobbered
  // by the single-char `>`/`<` rules.
  odata = odata.replace(/\s*>=\s*/g, ' ge ');
  odata = odata.replace(/\s*<=\s*/g, ' le ');
  odata = odata.replace(/\s*>\s*/g, ' gt ');
  odata = odata.replace(/\s*<\s*/g, ' lt ');

  // Convert double-quoted LINQ strings to OData single-quoted strings.
  odata = odata.replace(/"([^"]*)"/g, (_m, content) => `'${escapeODataString(content)}'`);

  // Logical operators.
  odata = odata.replace(/\s*&&\s*/g, ' and ');
  odata = odata.replace(/\s*\|\|\s*/g, ' or ');

  return odata.trim();
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
