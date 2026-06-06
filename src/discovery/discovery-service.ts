import * as crypto from 'crypto';
import type { Redis } from '@upstash/redis';
import { RockClient } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';
import {
  DiscoveryCandidate,
  scoreConnectGroupType,
  scoreMinistryTeamType,
  scoreLifecycleAttribute,
  scoreAgeGroupAttribute,
  scoreFluroIdAttribute,
  RockAttribute,
} from './confidence.js';

export interface FavorDiscoveryMap {
  generatedAt: string;
  rockBaseUrlHash: string;
  rockVersion?: string;
  confidence: number;
  campuses: DiscoveryCandidate[];
  groupTypes: {
    connectGroups: DiscoveryCandidate[];
    ministryTeams: DiscoveryCandidate[];
    other: DiscoveryCandidate[];
  };
  attributes: {
    personLifecycle: DiscoveryCandidate[];
    personAgeGroup: DiscoveryCandidate[];
    groupAgeGroup: DiscoveryCandidate[];
    fluroId: DiscoveryCandidate[];
  };
  reports: DiscoveryCandidate[];
  entitySearches: DiscoveryCandidate[];
  workflows: DiscoveryCandidate[];
  connectionTypes: DiscoveryCandidate[];
  warnings: string[];
}

export class DiscoveryService {
  private inMemoryMap: FavorDiscoveryMap | null = null;
  private inMemoryMapExpiresAt = 0;

  constructor(
    private rockClient: RockClient,
    private redis: Redis | null = null
  ) {}

  private getRedisKey(): string {
    const prefix = process.env.ROCK_MCP_REDIS_PREFIX || 'rock-mcp:prod:';
    return `${prefix}discovery:v17.7`;
  }

  public async getMap(ctx: OAuthRockContext): Promise<FavorDiscoveryMap> {
    // Check in-memory cache
    if (this.inMemoryMap && Date.now() < this.inMemoryMapExpiresAt) {
      return this.inMemoryMap;
    }

    // Check Redis cache if available
    const redisKey = this.getRedisKey();
    if (this.redis) {
      try {
        const cached = await this.redis.get(redisKey);
        if (cached) {
          const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
          this.inMemoryMap = parsed;
          this.inMemoryMapExpiresAt = Date.now() + 900000; // 15 min TTL
          return parsed;
        }
      } catch {
        // Fallback silently to in-memory/direct resolution on Redis failure
      }
    }

    // Run discovery
    const map = await this.runDiscovery(ctx);
    
    // Save to cache
    const ttlSeconds = parseInt(process.env.ROCK_MCP_DISCOVERY_TTL_SECONDS || '900', 10);
    this.inMemoryMap = map;
    this.inMemoryMapExpiresAt = Date.now() + ttlSeconds * 1000;

    if (this.redis) {
      try {
        await this.redis.set(redisKey, JSON.stringify(map), { ex: ttlSeconds });
      } catch {
        // Ignore redis save failure
      }
    }

    return map;
  }

  public async refresh(ctx: OAuthRockContext): Promise<void> {
    this.inMemoryMap = null;
    this.inMemoryMapExpiresAt = 0;
    if (this.redis) {
      try {
        await this.redis.del(this.getRedisKey());
      } catch {
        // Ignore redis del failure
      }
    }
    await this.getMap(ctx);
  }

  private async runDiscovery(ctx: OAuthRockContext): Promise<FavorDiscoveryMap> {
    const generatedAt = new Date().toISOString();
    const rockBaseUrl = process.env.ROCK_PUBLIC_URL || process.env.ROCK_API_URL || process.env.ROCK_BASE_URL || 'local';
    const rockBaseUrlHash = crypto.createHash('sha256').update(rockBaseUrl).digest('hex');
    
    let rockVersion = '17.7';
    try {
      const versionResult = await this.rockClient.get<any>(ctx, '/api/System/GetSystemInfo').catch(() => null);
      if (versionResult && versionResult.Version) {
        rockVersion = versionResult.Version;
      }
    } catch {
      // Keep default
    }

    const warnings: string[] = [];

    // Discover Campuses
    let campuses: DiscoveryCandidate[] = [];
    try {
      const campusList = await this.rockClient.post<any[]>(ctx, '/api/v2/models/campuses/search', {
        Where: 'IsActive == true',
      });
      campuses = campusList.map(c => ({
        kind: 'campus',
        id: c.Id,
        guid: c.Guid,
        name: c.Name,
        confidence: 1.0,
        signals: ['discovered active campus'],
      }));
    } catch (_err) {
      // Fall back to REST v1
      try {
        const campusList = await this.rockClient.get<any[]>(ctx, '/api/Campuses?$filter=IsActive eq true');
        campuses = campusList.map(c => ({
          kind: 'campus',
          id: c.Id,
          guid: c.Guid,
          name: c.Name,
          confidence: 1.0,
          signals: ['discovered active campus via REST v1 fallback'],
        }));
      } catch (err: any) {
        warnings.push(`failed to discover campuses: ${err.message}`);
      }
    }

    // Discover Group Types
    const connectGroups: DiscoveryCandidate[] = [];
    const ministryTeams: DiscoveryCandidate[] = [];
    const otherGroupTypes: DiscoveryCandidate[] = [];

    let groupTypeList: any[] = [];
    try {
      groupTypeList = await this.rockClient.post<any[]>(ctx, '/api/v2/models/grouptypes/search', {});
    } catch (_err) {
      // Fall back to REST v1
      try {
        groupTypeList = await this.rockClient.get<any[]>(ctx, '/api/GroupTypes');
      } catch (err: any) {
        warnings.push(`failed to discover group types: ${err.message}`);
      }
    }

    try {
      for (const gt of groupTypeList) {
        const cgScore = scoreConnectGroupType(gt.Name);
        const mtScore = scoreMinistryTeamType(gt.Name);

        const candidate: DiscoveryCandidate = {
          kind: 'groupType',
          id: gt.Id,
          guid: gt.Guid,
          name: gt.Name,
          confidence: 0,
          signals: [],
        };

        if (cgScore.confidence > 0.3) {
          candidate.confidence = cgScore.confidence;
          candidate.signals = cgScore.signals;
          connectGroups.push(candidate);
        } else if (mtScore.confidence > 0.3) {
          candidate.confidence = mtScore.confidence;
          candidate.signals = mtScore.signals;
          ministryTeams.push(candidate);
        } else {
          candidate.confidence = 0.1;
          candidate.signals = ['default group type'];
          otherGroupTypes.push(candidate);
        }
      }
    } catch (err: any) {
      warnings.push(`failed to parse group types: ${err.message}`);
    }

    // Discover Attributes
    const personLifecycleAttrs: DiscoveryCandidate[] = [];
    const personAgeGroupAttrs: DiscoveryCandidate[] = [];
    const groupAgeGroupAttrs: DiscoveryCandidate[] = [];
    const fluroIdAttrs: DiscoveryCandidate[] = [];

    let attributes: RockAttribute[] = [];
    try {
      attributes = await this.rockClient.post<RockAttribute[]>(ctx, '/api/v2/models/attributes/search', {});
    } catch (_err) {
      // Fall back to REST v1
      try {
        attributes = await this.rockClient.get<RockAttribute[]>(ctx, '/api/Attributes');
      } catch (err: any) {
        warnings.push(`failed to discover attributes: ${err.message}`);
      }
    }

    try {
      for (const attr of attributes) {
        const lifecycleScore = scoreLifecycleAttribute(attr);
        const ageGroupScore = scoreAgeGroupAttribute(attr);
        const fluroScore = scoreFluroIdAttribute(attr);

        // Build candidate if any scorer has confidence >= threshold
        if (lifecycleScore.confidence >= 0.4) {
          const entityType = attr.EntityType?.Name || '';
          const isPerson = entityType.toLowerCase() === 'person' || attr.EntityTypeId === 1;
          if (isPerson) {
            personLifecycleAttrs.push({
              kind: 'attribute.person',
              id: attr.Id,
              guid: attr.Guid,
              name: attr.Name || '',
              confidence: lifecycleScore.confidence,
              signals: lifecycleScore.signals,
            });
          }
        }

        if (ageGroupScore.confidence >= 0.4) {
          const entityType = attr.EntityType?.Name || '';
          const entityTypeId = attr.EntityTypeId || 0;
          const isPerson = entityType.toLowerCase() === 'person' || entityTypeId === 1;
          const isGroup = entityType.toLowerCase() === 'group' || entityTypeId === 2;

          if (isPerson || (entityTypeId === 0 && !entityType)) {
            personAgeGroupAttrs.push({
              kind: 'attribute.person',
              id: attr.Id,
              guid: attr.Guid,
              name: attr.Name || '',
              confidence: ageGroupScore.confidence,
              signals: ageGroupScore.signals,
            });
          }
          if (isGroup || (entityTypeId === 0 && !entityType)) {
            groupAgeGroupAttrs.push({
              kind: 'attribute.group',
              id: attr.Id,
              guid: attr.Guid,
              name: attr.Name || '',
              confidence: ageGroupScore.confidence,
              signals: ageGroupScore.signals,
            });
          }
        }

        if (fluroScore.confidence >= 0.4) {
          fluroIdAttrs.push({
            kind: 'attribute.external',
            id: attr.Id,
            guid: attr.Guid,
            name: attr.Name || '',
            confidence: fluroScore.confidence,
            signals: fluroScore.signals,
          });
        }
      }
    } catch (err: any) {
      warnings.push(`failed to parse attributes: ${err.message}`);
    }

    // Discover Reports
    let reports: DiscoveryCandidate[] = [];
    try {
      const reportList = await this.rockClient.get<any[]>(ctx, '/api/Reports');
      reports = reportList.map(r => ({
        kind: 'report',
        id: r.Id,
        guid: r.Guid,
        name: r.Name || '',
        confidence: 0.9,
        signals: ['discovered report'],
      }));
    } catch (err: any) {
      warnings.push(`failed to discover reports: ${err.message}`);
    }

    // Discover Entity Searches
    let entitySearches: DiscoveryCandidate[] = [];
    try {
      const searchList = await this.rockClient.post<any[]>(ctx, '/api/v2/models/entitysearches/search', {});
      entitySearches = searchList.map(s => ({
        kind: 'entitySearch',
        id: s.Id,
        guid: s.Guid,
        idKey: s.Key,
        name: s.Name || s.Key || '',
        confidence: 0.9,
        signals: ['discovered entity search'],
      }));
    } catch (_err) {
      // Fall back to REST v1
      try {
        const searchList = await this.rockClient.get<any[]>(ctx, '/api/EntitySearches');
        entitySearches = searchList.map(s => ({
          kind: 'entitySearch',
          id: s.Id,
          guid: s.Guid,
          idKey: s.Key,
          name: s.Name || s.Key || '',
          confidence: 0.9,
          signals: ['discovered entity search via REST v1 fallback'],
        }));
      } catch (err: any) {
        warnings.push(`failed to discover entity searches: ${err.message}`);
      }
    }

    // Discover Workflow Types
    let workflows: DiscoveryCandidate[] = [];
    try {
      const workflowList = await this.rockClient.post<any[]>(ctx, '/api/v2/models/workflowtypes/search', {});
      workflows = workflowList.map(w => ({
        kind: 'workflowType',
        id: w.Id,
        guid: w.Guid,
        name: w.Name || '',
        confidence: 0.9,
        signals: ['discovered workflow type'],
      }));
    } catch (_err) {
      // Fall back to REST v1
      try {
        const workflowList = await this.rockClient.get<any[]>(ctx, '/api/WorkflowTypes');
        workflows = workflowList.map(w => ({
          kind: 'workflowType',
          id: w.Id,
          guid: w.Guid,
          name: w.Name || '',
          confidence: 0.9,
          signals: ['discovered workflow type via REST v1 fallback'],
        }));
      } catch (err: any) {
        warnings.push(`failed to discover workflow types: ${err.message}`);
      }
    }

    // Discover Connection Types
    let connectionTypes: DiscoveryCandidate[] = [];
    try {
      const connList = await this.rockClient.post<any[]>(ctx, '/api/v2/models/connectiontypes/search', {});
      connectionTypes = connList.map(c => ({
        kind: 'connectionType',
        id: c.Id,
        guid: c.Guid,
        name: c.Name || '',
        confidence: 0.9,
        signals: ['discovered connection type'],
      }));
    } catch (_err) {
      // Fall back to REST v1
      try {
        const connList = await this.rockClient.get<any[]>(ctx, '/api/ConnectionTypes');
        connectionTypes = connList.map(c => ({
          kind: 'connectionType',
          id: c.Id,
          guid: c.Guid,
          name: c.Name || '',
          confidence: 0.9,
          signals: ['discovered connection type via REST v1 fallback'],
        }));
      } catch (err: any) {
        warnings.push(`failed to discover connection types: ${err.message}`);
      }
    }

    // Determine overall confidence: high if core discoveries succeeded, lower if warnings
    let overallConfidence = 1.0;
    if (warnings.length > 0) {
      overallConfidence = Math.max(0.5, 1.0 - warnings.length * 0.1);
    }

    return {
      generatedAt,
      rockBaseUrlHash,
      rockVersion,
      confidence: overallConfidence,
      campuses,
      groupTypes: {
        connectGroups: connectGroups.sort((a, b) => b.confidence - a.confidence),
        ministryTeams: ministryTeams.sort((a, b) => b.confidence - a.confidence),
        other: otherGroupTypes,
      },
      attributes: {
        personLifecycle: personLifecycleAttrs.sort((a, b) => b.confidence - a.confidence),
        personAgeGroup: personAgeGroupAttrs.sort((a, b) => b.confidence - a.confidence),
        groupAgeGroup: groupAgeGroupAttrs.sort((a, b) => b.confidence - a.confidence),
        fluroId: fluroIdAttrs.sort((a, b) => b.confidence - a.confidence),
      },
      reports,
      entitySearches,
      workflows,
      connectionTypes,
      warnings,
    };
  }
}
