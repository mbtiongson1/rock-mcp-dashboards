import { describe, it, expect } from 'vitest';
import { quoteLinqString, quoteODataString, assertValidGuid } from '../../src/rock/query.js';

describe('query sanitization', () => {
  describe('quoteLinqString', () => {
    it('should quote plain strings', () => {
      expect(quoteLinqString('John')).toBe('"John"');
    });

    it('should escape backslashes', () => {
      expect(quoteLinqString('back\\slash')).toBe('"back\\\\slash"');
    });

    it('should escape double quotes', () => {
      expect(quoteLinqString('say "hello"')).toBe('"say \\"hello\\""');
    });

    it('should handle both backslashes and double quotes', () => {
      expect(quoteLinqString('path\\to\\"file"')).toBe('"path\\\\to\\\\\\"file\\""');
    });

    it('should not escape single quotes', () => {
      expect(quoteLinqString("it's fine")).toBe('"it\'s fine"');
    });

    it('should handle empty string', () => {
      expect(quoteLinqString('')).toBe('""');
    });

    it('should handle strings with LINQ operators', () => {
      expect(quoteLinqString('test || value')).toBe('"test || value"');
    });

    it('should handle newlines and tabs', () => {
      expect(quoteLinqString('line1\nline2\ttab')).toBe('"line1\nline2\ttab"');
    });
  });

  describe('quoteODataString', () => {
    it('should quote plain strings', () => {
      expect(quoteODataString('test@example.com')).toBe("'test@example.com'");
    });

    it('should escape single quotes by doubling', () => {
      expect(quoteODataString("it's")).toBe("'it''s'");
    });

    it('should not escape double quotes', () => {
      expect(quoteODataString('say "hello"')).toBe("'say \"hello\"'");
    });

    it('should handle multiple single quotes', () => {
      expect(quoteODataString("can't won't")).toBe("'can''t won''t'");
    });

    it('should handle empty string', () => {
      expect(quoteODataString('')).toBe("''");
    });

    it('should handle OData operators', () => {
      expect(quoteODataString('eq ne and or')).toBe("'eq ne and or'");
    });
  });

  describe('assertValidGuid', () => {
    it('should accept valid GUIDs', () => {
      const validGuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(assertValidGuid(validGuid)).toBe(validGuid);
    });

    it('should accept GUIDs without hyphens', () => {
      const guidNoHyphens = '550e8400e29b41d4a716446655440000';
      expect(assertValidGuid(guidNoHyphens)).toBe(guidNoHyphens);
    });

    it('should throw on invalid GUID format', () => {
      expect(() => assertValidGuid('not-a-guid')).toThrow();
    });

    it('should throw on empty string', () => {
      expect(() => assertValidGuid('')).toThrow();
    });

    it('should throw on SQL injection attempt', () => {
      expect(() => assertValidGuid('550e8400-e29b-41d4-a716-446655440000" OR 1=1')).toThrow();
    });

    it('should throw on partial GUID', () => {
      expect(() => assertValidGuid('550e8400')).toThrow();
    });
  });
});
