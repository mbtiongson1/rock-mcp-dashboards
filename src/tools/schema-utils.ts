import { z } from 'zod';

/**
 * Utilities that make discriminated-union tool schemas usable by MCP clients.
 *
 * The MCP SDK can only serialize object schemas (or raw shapes) to JSON Schema
 * when advertising tools. A z.discriminatedUnion root is not introspectable, so
 * tools registered with one are advertised with an EMPTY input schema — calling
 * agents then have to guess action names and parameters, which is the primary
 * source of failed tool calls. `flattenUnionForAdvertisement` produces an
 * equivalent advertisement-only object schema; strict per-action validation
 * still happens inside each tool via the original union.
 */

type UnionOptions = Array<z.ZodObject<z.ZodRawShape>>;

function getUnionParts(schema: z.ZodTypeAny): { discriminator: string; options: UnionOptions } | null {
  const def = (schema as any)?._def;
  if (!def || def.typeName !== z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion) {
    return null;
  }
  return { discriminator: def.discriminator, options: def.options as UnionOptions };
}

function literalValue(field: z.ZodTypeAny): string | null {
  const def = (field as any)?._def;
  if (def?.typeName === z.ZodFirstPartyTypeKind.ZodLiteral && typeof def.value === 'string') {
    return def.value;
  }
  return null;
}

function baseDescription(field: z.ZodTypeAny): string | undefined {
  return (field as any)?.description;
}

/**
 * Extract the discriminator values (action names) from a discriminated union.
 * Returns [] for non-union schemas.
 */
export function extractActionNames(schema: z.ZodTypeAny): string[] {
  const parts = getUnionParts(schema);
  if (!parts) return [];
  const names: string[] = [];
  for (const option of parts.options) {
    const value = literalValue(option.shape[parts.discriminator] as z.ZodTypeAny);
    if (value !== null) names.push(value);
  }
  return names;
}

/**
 * Flatten a discriminated union into a single object schema suitable for tool
 * advertisement: the discriminator becomes a required enum and every other
 * field across all options becomes optional, annotated with the actions that
 * use it. Unknown keys pass through so the tool's strict per-action schema can
 * produce a precise error. Non-union schemas are returned unchanged.
 */
export function flattenUnionForAdvertisement(schema: z.ZodTypeAny): z.ZodTypeAny {
  const parts = getUnionParts(schema);
  if (!parts) return schema;

  const actionNames = extractActionNames(schema);
  const fieldSchemas = new Map<string, z.ZodTypeAny>();
  const fieldActions = new Map<string, string[]>();

  for (const option of parts.options) {
    const action = literalValue(option.shape[parts.discriminator] as z.ZodTypeAny) ?? '?';
    for (const [key, field] of Object.entries(option.shape)) {
      if (key === parts.discriminator) continue;
      if (!fieldSchemas.has(key)) fieldSchemas.set(key, field as z.ZodTypeAny);
      const used = fieldActions.get(key) ?? [];
      used.push(action);
      fieldActions.set(key, used);
    }
  }

  const shape: z.ZodRawShape = {
    [parts.discriminator]: z
      .enum(actionNames as [string, ...string[]])
      .describe(`The operation to perform. One of: ${actionNames.join(', ')}.`),
  };

  for (const [key, field] of fieldSchemas.entries()) {
    const usedBy = fieldActions.get(key) ?? [];
    const scope = usedBy.length === actionNames.length ? 'all actions' : `actions: ${usedBy.join(', ')}`;
    const existing = baseDescription(field);
    const description = existing ? `${existing} (${scope})` : `Used by ${scope}.`;
    shape[key] = field.optional().describe(description);
  }

  return z.object(shape).passthrough();
}

/**
 * Append the derived action list to a tool description so agents see valid
 * actions upfront instead of discovering them through failed calls.
 */
export function describeWithActions(description: string, schema: z.ZodTypeAny): string {
  const actions = extractActionNames(schema);
  if (actions.length === 0) return description;
  const sep = description.endsWith('.') ? '' : '.';
  return `${description}${sep} Actions: ${actions.join(', ')}.`;
}

/**
 * Produce a human/agent-friendly message for a ZodError thrown by a tool's
 * strict argument parse. Lists valid actions on discriminator failures and
 * surfaces field descriptions as hints on missing/invalid params.
 */
export function describeToolValidationError(toolName: string, error: z.ZodError, schema: z.ZodTypeAny, args?: unknown): string {
  const actions = extractActionNames(schema);
  const parts = getUnionParts(schema);
  const lines: string[] = [];

  // Build a field-description lookup from the union options for hints.
  const fieldHints = new Map<string, string>();
  if (parts) {
    for (const option of parts.options) {
      for (const [key, field] of Object.entries(option.shape)) {
        const desc = baseDescription(field as z.ZodTypeAny);
        if (desc && !fieldHints.has(key)) fieldHints.set(key, desc);
      }
    }
  }

  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.invalid_union_discriminator) {
      const discriminator = parts?.discriminator ?? 'action';
      const receivedValue = args && typeof args === 'object'
        ? (args as Record<string, unknown>)[discriminator]
        : undefined;
      const received = receivedValue !== undefined ? ` '${String(receivedValue)}'` : '';
      lines.push(
        `Invalid or missing '${discriminator}'${received}. ` +
        `Valid actions for ${toolName}: ${actions.join(', ')}.`
      );
      continue;
    }
    const path = issue.path.join('.') || '(root)';
    const hint = fieldHints.get(String(issue.path[0] ?? ''));
    lines.push(`${path}: ${issue.message}${hint ? ` — ${hint}` : ''}`);
  }

  return lines.join(' | ');
}
