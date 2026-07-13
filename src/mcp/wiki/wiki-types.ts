import { z } from 'zod';

/**
 * A `liveBinding` connects a curated wiki article to a live Rock structure so
 * the handler can append current values/counts at read time. Each kind maps to
 * a slice of the RockDiscoveryMap (or, for `definedType`, to a DefinedValue
 * lookup) — see `live-overlay.ts`.
 */
export const liveBindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('definedType'),
    /** DefinedType.Name resolved at runtime (e.g. 'Connection Status'). */
    definedTypeName: z.string().min(1),
    /** Optional documentation hint only; resolution is by name (failure-safe). */
    definedTypeId: z.number().optional(),
    /** When true, append live per-value people counts via the connection-status count helper. */
    countsByStatus: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('groupType'),
    match: z.enum(['connectGroups', 'ministryTeams', 'other']),
  }),
  z.object({
    kind: z.literal('attribute'),
    match: z.enum(['personLifecycle', 'personAgeGroup', 'groupAgeGroup', 'fluroId']),
  }),
  z.object({ kind: z.literal('campuses') }),
  z.object({ kind: z.literal('connectionTypes') }),
  z.object({ kind: z.literal('workflows') }),
  z.object({ kind: z.literal('reports') }),
]);

export type LiveBinding = z.infer<typeof liveBindingSchema>;

/**
 * YAML-ish front-matter contract for a wiki topic. `id` must equal the file
 * stem (slug). `aliases` are search synonyms; `tags` group related topics.
 */
export const frontMatterSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug (a-z, 0-9, hyphen)'),
  title: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  liveBinding: liveBindingSchema.optional(),
});

export type FrontMatter = z.infer<typeof frontMatterSchema>;

export interface WikiArticle {
  frontMatter: FrontMatter;
  /** Markdown body following the front-matter block. */
  body: string;
  /** Absolute source path, for diagnostics. */
  sourcePath: string;
}
