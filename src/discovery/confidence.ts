export interface DiscoveryCandidate {
  kind: string;
  id?: number;
  guid?: string;
  idKey?: string;
  name: string;
  confidence: number;
  signals: string[];
  warnings?: string[];
}

/**
 * Rock API Attribute object (partial shape for discovery).
 * May include EntityType or EntityTypeId to identify applicability.
 */
export interface RockAttribute {
  Id?: number;
  Guid?: string;
  Name?: string;
  Key?: string;
  Description?: string;
  IsActive?: boolean;
  EntityTypeId?: number;
  EntityType?: { Name?: string };
  AttributeValues?: Array<{ Value?: string }>;
}

export function scoreConnectGroupType(name: string): { confidence: number; signals: string[] } {
  let confidence = 0.0;
  const signals: string[] = [];
  const lowerName = name.toLowerCase();

  // Strong match: exact singular or plural canonical name
  if (name === 'Connect Groups' || name === 'Connect Group') {
    confidence += 0.60;
    signals.push(`exact name match: ${name}`);
  } else if (lowerName.includes('connect') && lowerName.includes('group')) {
    confidence += 0.35;
    signals.push('name contains Connect and Group');
  }

  // Penalize wrapper/container terms — these are structural containers, not the type itself
  if (
    lowerName.includes('section') ||
    lowerName.includes('area') ||
    lowerName.includes('region') ||
    lowerName.includes('category')
  ) {
    confidence -= 0.20;
    signals.push('name contains wrapper/container term (section/area/region/category)');
  }

  // Check signals/warnings
  if (lowerName.includes('archived') || lowerName.includes('old') || lowerName.includes('deprecated')) {
    confidence -= 0.30;
    signals.push('name contains old/deprecated warning');
  }

  return {
    confidence: Math.max(0, Math.min(1.0, confidence)),
    signals,
  };
}

export function scoreMinistryTeamType(name: string): { confidence: number; signals: string[] } {
  let confidence = 0.0;
  const signals: string[] = [];
  const lowerName = name.toLowerCase();

  // Strong match: exact singular or plural canonical name
  if (name === 'Ministry Teams' || name === 'Ministry Team') {
    confidence += 0.60;
    signals.push(`exact name match: ${name}`);
  } else if (lowerName.includes('ministry') && lowerName.includes('team')) {
    confidence += 0.35;
    signals.push('name contains Ministry and Team');
  } else if (lowerName.includes('serving') || lowerName.includes('service') || lowerName.includes('volunteer')) {
    confidence += 0.20;
    signals.push('name contains serving/volunteer context');
  }

  // Penalize wrapper/container terms — these are structural containers, not the type itself
  if (
    lowerName.includes('section') ||
    lowerName.includes('area') ||
    lowerName.includes('region') ||
    lowerName.includes('category')
  ) {
    confidence -= 0.20;
    signals.push('name contains wrapper/container term (section/area/region/category)');
  }

  if (lowerName.includes('archived') || lowerName.includes('old') || lowerName.includes('deprecated')) {
    confidence -= 0.30;
    signals.push('name contains old/deprecated warning');
  }

  return {
    confidence: Math.max(0, Math.min(1.0, confidence)),
    signals,
  };
}

/**
 * Score a Rock attribute as a candidate for Person Lifecycle status.
 * Signals: name/key matches lifecycle keywords, defined values include Favor lifecycle terms,
 * applies to Person, is active.
 */
export function scoreLifecycleAttribute(attr: RockAttribute): { confidence: number; signals: string[] } {
  let confidence = 0.0;
  const signals: string[] = [];

  if (!attr) {
    return { confidence: 0, signals };
  }

  const name = attr.Name || '';
  const key = attr.Key || '';
  const combined = `${name} ${key}`.toLowerCase();

  // Check name/key for lifecycle keywords
  const lifecycleTerms = ['lifecycle', 'connection status', 'connectionstatus', 'new', 'crowd', 'core', 'leader'];
  const matchedTerms = lifecycleTerms.filter(term => combined.includes(term));

  if (matchedTerms.length > 0) {
    confidence += 0.45;
    signals.push(`name/key contains lifecycle term(s): ${matchedTerms.join(', ')}`);
  }

  // Check defined values for Favor lifecycle terms
  const favorLifecycleTerms = ['new', 'crowd', 'core', 'leader'];
  if (attr.AttributeValues && Array.isArray(attr.AttributeValues)) {
    const values = attr.AttributeValues.map(av => (av.Value || '').toLowerCase());
    const matchedValues = favorLifecycleTerms.filter(term => values.some(v => v.includes(term)));

    if (matchedValues.length >= 2) {
      confidence += 0.30;
      signals.push(`defined values include multiple Favor lifecycle terms: ${matchedValues.join(', ')}`);
    }
  }

  // Check if applies to Person
  const entityType = attr.EntityType?.Name || '';
  if (entityType.toLowerCase() === 'person' || attr.EntityTypeId === 1) {
    confidence += 0.15;
    signals.push('applies to Person entity type');
  }

  // Check if active
  if (attr.IsActive !== false) {
    confidence += 0.10;
    signals.push('attribute is active');
  }

  return {
    confidence: Math.max(0, Math.min(1.0, confidence)),
    signals,
  };
}

/**
 * Score a Rock attribute as a candidate for Age Group.
 * Signals: name/key matches age group keywords, defined values include age group labels,
 * applies to Person or Group.
 */
export function scoreAgeGroupAttribute(attr: RockAttribute): { confidence: number; signals: string[] } {
  let confidence = 0.0;
  const signals: string[] = [];

  if (!attr) {
    return { confidence: 0, signals };
  }

  const name = attr.Name || '';
  const key = attr.Key || '';
  const combined = `${name} ${key}`.toLowerCase();

  // Check name/key for age group keywords
  if (combined.includes('age group') || combined.includes('agegroup')) {
    confidence += 0.50;
    signals.push('name/key contains "age group"');
  }

  // Check defined values for age group labels
  const ageGroupTerms = ['kids', 'youth', 'young adults', 'adults', 'seasoned'];
  if (attr.AttributeValues && Array.isArray(attr.AttributeValues)) {
    const values = attr.AttributeValues.map(av => (av.Value || '').toLowerCase());
    const matchedValues = ageGroupTerms.filter(term => values.some(v => v.includes(term)));

    if (matchedValues.length > 0) {
      confidence += 0.35;
      signals.push(`defined values include age group labels: ${matchedValues.join(', ')}`);
    }
  }

  // Check if applies to Person or Group
  const entityType = (attr.EntityType?.Name || '').toLowerCase();
  if (entityType === 'person' || attr.EntityTypeId === 1) {
    confidence += 0.10;
    signals.push('applies to Person');
  } else if (entityType === 'group' || attr.EntityTypeId === 2) {
    confidence += 0.10;
    signals.push('applies to Group');
  } else if (!entityType && !attr.EntityTypeId) {
    confidence += 0.05;
    signals.push('entity applicability inferred conservatively');
  }

  // Check if active
  if (attr.IsActive !== false) {
    confidence += 0.05;
    signals.push('attribute is active');
  }

  return {
    confidence: Math.max(0, Math.min(1.0, confidence)),
    signals,
  };
}

/**
 * Score a Rock attribute as a candidate for Fluro ID / Legacy ID.
 * Signals: name/key matches external ID keywords, applies to Person/Group/migration entity.
 */
export function scoreFluroIdAttribute(attr: RockAttribute): { confidence: number; signals: string[] } {
  let confidence = 0.0;
  const signals: string[] = [];

  if (!attr) {
    return { confidence: 0, signals };
  }

  const name = attr.Name || '';
  const key = attr.Key || '';
  const combined = `${name} ${key}`.toLowerCase();

  // Check name/key for external ID keywords
  const externalIdTerms = ['fluro', 'fluro id', 'legacy id', 'external id', 'externalid', 'legacy'];
  const matchedTerms = externalIdTerms.filter(term => combined.includes(term));

  if (matchedTerms.length > 0) {
    confidence += 0.60;
    signals.push(`name/key contains external ID term(s): ${matchedTerms.join(', ')}`);
  }

  // Check if applies to a migration/integration entity
  const entityType = attr.EntityType?.Name || '';
  const integrationType = entityType.toLowerCase();

  if (integrationType === 'person' || attr.EntityTypeId === 1) {
    confidence += 0.20;
    signals.push('applies to Person (likely stores legacy person IDs)');
  } else if (integrationType === 'group' || attr.EntityTypeId === 2) {
    confidence += 0.20;
    signals.push('applies to Group (likely stores legacy group IDs)');
  } else if (integrationType.includes('integration') || integrationType.includes('migration')) {
    confidence += 0.25;
    signals.push(`applies to ${entityType} entity type`);
  }

  // Check if active
  if (attr.IsActive !== false) {
    confidence += 0.05;
    signals.push('attribute is active');
  }

  return {
    confidence: Math.max(0, Math.min(1.0, confidence)),
    signals,
  };
}
