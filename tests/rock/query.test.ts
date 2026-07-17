import { describe, it, expect } from 'vitest';
import { quoteLinqString, quoteODataString, assertValidGuid, linqToOData } from '../../src/rock/query.js';

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

  describe('linqToOData', () => {
    it('returns empty string for undefined/empty input', () => {
      expect(linqToOData()).toBe('');
      expect(linqToOData('')).toBe('');
    });

    it('translates equality operators', () => {
      expect(linqToOData('PrimaryCampusId == 2')).toBe('PrimaryCampusId eq 2');
      expect(linqToOData('IsActive != true')).toBe('IsActive ne true');
    });

    it('translates logical operators', () => {
      expect(linqToOData('A == 1 && B == 2')).toBe('A eq 1 and B eq 2');
      expect(linqToOData('A == 1 || B == 2')).toBe('A eq 1 or B eq 2');
    });

    // Regression: rock_entity search on Attendances with a range filter 400'd
    // ("character '>' is not valid") because >=/<= were never translated.
    it('translates relational operators, two-char forms before single-char', () => {
      expect(linqToOData('OccurrenceId >= 34885 && OccurrenceId <= 34899')).toBe(
        'OccurrenceId ge 34885 and OccurrenceId le 34899'
      );
      expect(linqToOData('Age > 18')).toBe('Age gt 18');
      expect(linqToOData('Age < 65')).toBe('Age lt 65');
    });

    // Regression: `.Contains()` reached Rock verbatim → "unknown function 'Name.Contains'".
    it('translates .Contains() to substringof(...) eq true', () => {
      expect(linqToOData('Name.Contains("No Names")')).toBe(
        "substringof('No Names', Name) eq true"
      );
    });

    it('translates .StartsWith() and .EndsWith()', () => {
      expect(linqToOData('Name.StartsWith("Youth")')).toBe(
        "startswith(Name, 'Youth') eq true"
      );
      expect(linqToOData('Name.EndsWith("Team")')).toBe(
        "endswith(Name, 'Team') eq true"
      );
    });

    it('handles a dotted navigation path in a method call', () => {
      expect(linqToOData('Person.NickName.Contains("Jo")')).toBe(
        "substringof('Jo', Person.NickName) eq true"
      );
    });

    // Regression: an MCP client sent HTML-escaped quotes → "character '&' is not valid".
    it('decodes HTML entities before translating', () => {
      expect(linqToOData('Name.Contains(&quot;No Names&quot;)')).toBe(
        "substringof('No Names', Name) eq true"
      );
      expect(linqToOData('A == 1 &amp;&amp; B == 2')).toBe('A eq 1 and B eq 2');
    });

    it('converts double-quoted string literals to single-quoted and escapes single quotes', () => {
      expect(linqToOData('LastName == "O\'Brien"')).toBe("LastName eq 'O''Brien'");
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
