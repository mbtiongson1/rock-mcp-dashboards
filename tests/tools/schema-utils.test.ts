import { describe, it, expect } from 'vitest';
import { z } from 'zod';
// @ts-ignore
import { flattenUnionForAdvertisement, extractActionNames, describeToolValidationError } from '../../src/tools/schema-utils.js';

const union = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('find'),
    query: z.string().min(1).describe('Name fragment to search'),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
  z.object({
    action: z.literal('count'),
    model: z.string().min(1).describe("Rock model name, e.g. 'people'"),
  }),
]);

describe('extractActionNames', () => {
  it('lists all discriminator values', () => {
    expect(extractActionNames(union)).toEqual(['find', 'count']);
  });

  it('returns empty array for non-union schemas', () => {
    expect(extractActionNames(z.object({ a: z.string() }))).toEqual([]);
  });
});

describe('flattenUnionForAdvertisement', () => {
  it('returns an introspectable ZodObject (has .shape) for a discriminated union', () => {
    const flat = flattenUnionForAdvertisement(union) as z.ZodObject<any>;
    expect(flat.shape).toBeDefined();
    expect(Object.keys(flat.shape)).toEqual(expect.arrayContaining(['action', 'query', 'limit', 'model']));
  });

  it('keeps action required with all valid values', () => {
    const flat = flattenUnionForAdvertisement(union) as z.ZodObject<any>;
    expect(flat.shape.action.safeParse('find').success).toBe(true);
    expect(flat.shape.action.safeParse('count').success).toBe(true);
    expect(flat.shape.action.safeParse('filter').success).toBe(false);
    expect(flat.safeParse({ query: 'x' }).success).toBe(false);
  });

  it('makes non-discriminator fields optional and annotates applicable actions', () => {
    const flat = flattenUnionForAdvertisement(union) as z.ZodObject<any>;
    expect(flat.safeParse({ action: 'find', query: 'Alex' }).success).toBe(true);
    // model belongs to count but must not block find at the advertisement layer
    expect(flat.safeParse({ action: 'find', query: 'Alex', model: 'people' }).success).toBe(true);
    expect(flat.shape.model.description).toContain('count');
    expect(flat.shape.query.description).toContain('Name fragment');
  });

  it('passes through unknown keys so the strict per-action schema sees them', () => {
    const flat = flattenUnionForAdvertisement(union) as z.ZodObject<any>;
    const parsed = flat.parse({ action: 'find', query: 'x', campusName: 'Manila' });
    expect((parsed as any).campusName).toBe('Manila');
  });

  it('returns non-union schemas unchanged', () => {
    const obj = z.object({ a: z.string() });
    expect(flattenUnionForAdvertisement(obj)).toBe(obj);
  });
});

describe('describeToolValidationError', () => {
  it('lists valid actions when the discriminator is invalid', () => {
    const result = union.safeParse({ action: 'filter' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = describeToolValidationError('rock_test', result.error, union, { action: 'filter' });
    expect(message).toContain("'filter'");
    expect(message).toContain('find');
    expect(message).toContain('count');
  });

  it('includes field hints from descriptions for missing required params', () => {
    const result = union.safeParse({ action: 'count' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = describeToolValidationError('rock_test', result.error, union);
    expect(message).toContain('model');
    expect(message).toContain("e.g. 'people'");
  });
});
