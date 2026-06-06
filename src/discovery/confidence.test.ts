import { describe, it, expect } from 'vitest';
import {
  scoreLifecycleAttribute,
  scoreAgeGroupAttribute,
  scoreFluroIdAttribute,
  RockAttribute,
} from './confidence.js';

describe('Attribute Confidence Scorers', () => {
  describe('scoreLifecycleAttribute', () => {
    it('should score high for explicit lifecycle status attribute', () => {
      const attr: RockAttribute = {
        Name: 'Connection Status',
        Key: 'connection_status',
        IsActive: true,
        EntityTypeId: 1, // Person
        AttributeValues: [
          { Value: 'New' },
          { Value: 'Crowd' },
          { Value: 'Core' },
          { Value: 'Leader' },
        ],
      };

      const result = scoreLifecycleAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.75);
      expect(result.signals.join(' ').toLowerCase()).toContain('connection status');
    });

    it('should score high for lifecycle keyword in key', () => {
      const attr: RockAttribute = {
        Name: 'Status',
        Key: 'person_lifecycle',
        IsActive: true,
        EntityTypeId: 1,
        AttributeValues: [{ Value: 'New' }, { Value: 'Core' }],
      };

      const result = scoreLifecycleAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.70);
    });

    it('should score lower without lifecycle values', () => {
      const attr: RockAttribute = {
        Name: 'Connection Status',
        Key: 'conn_status',
        IsActive: true,
        EntityTypeId: 1,
        AttributeValues: [{ Value: 'Active' }, { Value: 'Inactive' }],
      };

      const result = scoreLifecycleAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.50);
      expect(result.confidence).toBeLessThanOrEqual(0.75);
    });

    it('should score lower for attribute without Person applicability', () => {
      const attr: RockAttribute = {
        Name: 'Connection Status',
        Key: 'conn_status',
        IsActive: true,
        EntityTypeId: 2, // Group
        AttributeValues: [{ Value: 'New' }, { Value: 'Core' }],
      };

      const result = scoreLifecycleAttribute(attr);
      // When entity type is not Person, Person entity scorer signals are not applied
      // But name/key and values still score, giving 0.45 + 0.30 + 0.10 = 0.85
      expect(result.confidence).toBeLessThanOrEqual(0.85);
    });

    it('should score zero for null attribute', () => {
      const result = scoreLifecycleAttribute(null as any);
      expect(result.confidence).toBe(0);
      expect(result.signals).toHaveLength(0);
    });

    it('should clamp confidence to [0, 1]', () => {
      const attr: RockAttribute = {
        Name: 'Lifecycle',
        Key: 'lifecycle',
        IsActive: true,
        EntityTypeId: 1,
        AttributeValues: [
          { Value: 'New' },
          { Value: 'Crowd' },
          { Value: 'Core' },
          { Value: 'Leader' },
        ],
      };

      const result = scoreLifecycleAttribute(attr);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  describe('scoreAgeGroupAttribute', () => {
    it('should score high for explicit age group attribute', () => {
      const attr: RockAttribute = {
        Name: 'Age Group',
        Key: 'age_group',
        IsActive: true,
        EntityTypeId: 1, // Person
        AttributeValues: [
          { Value: 'Kids' },
          { Value: 'Youth' },
          { Value: 'Young Adults' },
          { Value: 'Adults' },
        ],
      };

      const result = scoreAgeGroupAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.80);
      expect(result.signals.join(' ').toLowerCase()).toContain('age group');
    });

    it('should score high for "agegroup" keyword', () => {
      const attr: RockAttribute = {
        Name: 'Student Age Group',
        Key: 'agegroup',
        IsActive: true,
        EntityTypeId: 1,
        AttributeValues: [{ Value: 'Youth' }, { Value: 'Young Adults' }],
      };

      const result = scoreAgeGroupAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.75);
    });

    it('should apply to Group entity type', () => {
      const attr: RockAttribute = {
        Name: 'Age Group',
        Key: 'age_group',
        IsActive: true,
        EntityTypeId: 2, // Group
        AttributeValues: [{ Value: 'Kids' }, { Value: 'Adults' }],
      };

      const result = scoreAgeGroupAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.65);
    });

    it('should score lower without age group values', () => {
      const attr: RockAttribute = {
        Name: 'Age Group',
        Key: 'age_group',
        IsActive: true,
        EntityTypeId: 1,
        AttributeValues: [{ Value: 'Option A' }, { Value: 'Option B' }],
      };

      const result = scoreAgeGroupAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.40);
      expect(result.confidence).toBeLessThan(0.70);
    });

    it('should handle unknown entity types conservatively', () => {
      const attr: RockAttribute = {
        Name: 'Age Group',
        Key: 'age_group',
        IsActive: true,
        AttributeValues: [{ Value: 'Kids' }, { Value: 'Adults' }],
      };

      const result = scoreAgeGroupAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.55);
      expect(result.signals.join(' ').toLowerCase()).toContain('inferred');
    });

    it('should correctly recognize capitalized EntityType.Name (Person)', () => {
      const attr: RockAttribute = {
        Name: 'Age Group',
        Key: 'age_group',
        IsActive: true,
        EntityType: { Name: 'Person' }, // Capitalized
        AttributeValues: [{ Value: 'Kids' }, { Value: 'Adults' }],
      };

      const result = scoreAgeGroupAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.80);
      expect(result.signals).toContain('applies to Person');
    });

    it('should score zero for null attribute', () => {
      const result = scoreAgeGroupAttribute(null as any);
      expect(result.confidence).toBe(0);
      expect(result.signals).toHaveLength(0);
    });
  });

  describe('scoreFluroIdAttribute', () => {
    it('should score high for explicit Fluro ID attribute', () => {
      const attr: RockAttribute = {
        Name: 'Fluro ID',
        Key: 'fluro_id',
        IsActive: true,
        EntityTypeId: 1, // Person
      };

      const result = scoreFluroIdAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.75);
      expect(result.signals.join(' ').toLowerCase()).toContain('fluro');
    });

    it('should score high for legacy ID', () => {
      const attr: RockAttribute = {
        Name: 'Legacy System ID',
        Key: 'legacy_id',
        IsActive: true,
        EntityTypeId: 1,
      };

      const result = scoreFluroIdAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.70);
    });

    it('should apply to Group entity', () => {
      const attr: RockAttribute = {
        Name: 'External ID',
        Key: 'external_id',
        IsActive: true,
        EntityTypeId: 2, // Group
      };

      const result = scoreFluroIdAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0.70);
    });

    it('should score lower without clear external ID keyword', () => {
      const attr: RockAttribute = {
        Name: 'System Reference',
        Key: 'sys_ref',
        IsActive: true,
        EntityTypeId: 1,
      };

      const result = scoreFluroIdAttribute(attr);
      expect(result.confidence).toBeLessThan(0.40);
    });

    it('should score zero for null attribute', () => {
      const result = scoreFluroIdAttribute(null as any);
      expect(result.confidence).toBe(0);
      expect(result.signals).toHaveLength(0);
    });

    it('should clamp confidence to [0, 1]', () => {
      const attr: RockAttribute = {
        Name: 'Fluro Legacy ID',
        Key: 'fluro_legacy_id',
        IsActive: true,
        EntityTypeId: 1,
      };

      const result = scoreFluroIdAttribute(attr);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });

    it('should handle inactive attributes', () => {
      const attr: RockAttribute = {
        Name: 'Fluro ID',
        Key: 'fluro_id',
        IsActive: false,
        EntityTypeId: 1,
      };

      const result = scoreFluroIdAttribute(attr);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThan(0.85);
    });
  });
});
