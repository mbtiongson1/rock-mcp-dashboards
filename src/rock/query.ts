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
 * Build the OData pagination fragment for a v1 REST query, guaranteeing that
 * `$orderby` is present whenever `$skip` is. Rock's v1 API (EF / LINQ-to-Entities)
 * throws "The method 'Skip' is only supported for sorted input in LINQ to
 * Entities. The method 'OrderBy' must be called before the method 'Skip'." when
 * a query is skipped without a preceding sort. Any paginated v1 query MUST route
 * through this so an ordering is always applied.
 *
 * @param opts.top     `$top` page size (omitted when falsy).
 * @param opts.skip    `$skip` offset (omitted when 0; forces `$orderby` when > 0).
 * @param opts.orderBy Sort field. Defaults to `Id` — always present and stable.
 * @returns A `&`-joined fragment with NO leading separator, or `''` if nothing
 *          needs paginating. Callers append it to their existing query string.
 */
export function odataPagination(opts: { top?: number; skip?: number; orderBy?: string }): string {
  const { top, skip = 0, orderBy = 'Id' } = opts;
  const parts: string[] = [];
  // $orderby MUST accompany $skip; also emit it when a caller explicitly asks.
  if (skip > 0 || opts.orderBy) {
    parts.push(`$orderby=${orderBy}`);
  }
  if (top) {
    parts.push(`$top=${top}`);
  }
  if (skip > 0) {
    parts.push(`$skip=${skip}`);
  }
  return parts.join('&');
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
 * Zero-pad a number to a fixed width (e.g. `pad(7, 2)` -> `'07'`).
 */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Format a Date as an OData v3 datetime literal body `YYYY-MM-DDTHH:MM:SS`
 * (no surrounding `datetime'...'`), using the local components of `d`.
 */
function toODataDateLiteralBody(d: Date): string {
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}` +
    `T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`
  );
}

// GUID content (8-4-4-4-12 hex, hyphens optional). Kept in sync with assertValidGuid.
const GUID_LITERAL_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * Translate a Dynamic-LINQ-style `where` clause (as accepted by Rock's v2 search)
 * into an OData v3 `$filter` expression for the v1 REST fallback.
 *
 * Rock's v1 API speaks WCF Data Services OData v3, which differs from LINQ in
 * several ways this handles: relational operators are word tokens
 * (`gt`/`lt`/`ge`/`le`, not `>`/`<`/`>=`/`<=`); string matching uses the
 * `substringof`/`startswith`/`endswith` functions rather than `.Contains()` etc.;
 * string literals are single-quoted, not double-quoted; and date/GUID values are
 * typed literals (`datetime'...'` / `guid'...'`) rather than LINQ constructors or
 * plain strings.
 *
 * This is a best-effort, regex-based translation for the common filter shapes —
 * it does NOT parse the expression, so an operator or entity that appears inside
 * a quoted string literal may be rewritten too. Keep `where` clauses simple.
 *
 * @param where The LINQ-style filter clause.
 * @param now   Clock used to resolve relative dates (`DateTime.Now`/`.Today`).
 *              Injectable for deterministic tests; defaults to the current time.
 */
export function linqToOData(where?: string, now: Date = new Date()): string {
  if (!where) return '';
  let odata = decodeHtmlEntities(where);

  // Relative-date constructors -> concrete OData datetime literals. Done before the
  // `DateTime(...)` rule below (these have no parens) and before quote/operator steps
  // (the emitted `datetime'...'` is single-quoted digits, untouched by later rules).
  // `.Today` / `.Now.Date` -> midnight today; `.Now` / `.UtcNow` -> full timestamp.
  // Date arithmetic (`.AddDays(...)`) is intentionally NOT handled.
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  odata = odata
    .replace(/DateTime\.Now\.Date/gi, `datetime'${toODataDateLiteralBody(midnight)}'`)
    .replace(/DateTime\.Today/gi, `datetime'${toODataDateLiteralBody(midnight)}'`)
    .replace(/DateTime\.(?:Now|UtcNow)/gi, `datetime'${toODataDateLiteralBody(now)}'`);

  // `DateTime(y, m, d[, h, mi, s])` constructor -> `datetime'YYYY-MM-DDTHH:MM:SS'`.
  // Only 3–6 integer args are accepted; anything else is left unchanged so a
  // malformed clause fails visibly rather than producing a wrong date.
  odata = odata.replace(/DateTime\(\s*([\d\s,]+?)\s*\)/gi, (match, argList: string) => {
    const parts = argList.split(',').map((p) => p.trim());
    if (parts.some((p) => !/^\d+$/.test(p))) return match;
    const nums = parts.map((p) => parseInt(p, 10));
    if (nums.length < 3 || nums.length > 6) return match;
    const [y, mo, d, h = 0, mi = 0, s = 0] = nums;
    const body =
      `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}`;
    return `datetime'${body}'`;
  });

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

  // GUID-valued literals -> typed `guid'...'` literals. Runs after quote conversion so
  // both `"..."` and `'...'` inputs are covered. Tightly scoped to the full GUID shape
  // so ordinary string values (which are never 8-4-4-4-12 hex) are never mis-prefixed.
  // The negative lookbehind avoids double-prefixing an already-typed `guid'...'` literal.
  odata = odata.replace(/(?<!guid)'([^']*)'/gi, (match, content: string) =>
    GUID_LITERAL_RE.test(content) ? `guid'${content}'` : match
  );

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
