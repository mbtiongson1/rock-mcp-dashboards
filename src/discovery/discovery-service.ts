import * as crypto from 'crypto';
import { RockClient } from '../rock/client.js';
import { OAuthRockContext } from '../http/oauth.js';
import {
  DiscoveryCandidate,
  scoreConnectGroupType,
  scoreMinistryTeamType,
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
    private redis: any = null // Expect Upstash Redis client or null
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

    // Default placeholders for attributes/reports/savedsearches (discoverable properties in v1.7.7)
    return {
      generatedAt,
      rockBaseUrlHash,
      rockVersion,
      confidence: 1.0,
      campuses,
      groupTypes: {
        connectGroups: connectGroups.sort((a, b) => b.confidence - a.confidence),
        ministryTeams: ministryTeams.sort((a, b) => b.confidence - a.confidence),
        other: otherGroupTypes,
      },
      attributes: {
        personLifecycle: [
          { kind: 'attribute.person', name: 'Connection Status', confidence: 0.95, signals: ['standard Rock field'] }
        ],
        personAgeGroup: [
          { kind: 'attribute.person', name: 'Age Group', confidence: 0.85, signals: ['inferred age group'] }
        ],
        groupAgeGroup: [],
        fluroId: [],
      },
      reports: [],
      entitySearches: [],
      workflows: [],
      connectionTypes: [],
      warnings,
    };
  }
}
