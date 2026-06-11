import * as crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { OAuthRockContext } from '../http/oauth.js';
import { getRedisPrefix } from '../rock/redis.js';

export interface StoredDataset {
  id: string;
  owner: {
    oauthSubjectHash: string;
    rockPersonId?: number;
    sessionId?: string;
  };
  title: string;
  createdAt: string;
  expiresAt: string;
  source: {
    tool: string;
    action: string;
    model?: string;
    reportId?: number;
    searchKey?: string;
  };
  columns: string[];
  rows: Record<string, unknown>[];
  summary?: string;
  sensitivity: 'low' | 'person' | 'sensitive' | 'financial';
}

/**
 * Interface for dataset storage implementations.
 */
export interface DatasetStore {
  put(dataset: StoredDataset, ttlSeconds?: number): Promise<string>;
  get(datasetId: string, ctx: OAuthRockContext): Promise<StoredDataset | null>;
  delete(datasetId: string, ctx: OAuthRockContext): Promise<void>;
}

/**
 * Helper to check dataset ownership against the OAuth subject.
 * Throws if ownership mismatch.
 */
function enforceOwnership(dataset: StoredDataset, ctx: OAuthRockContext): void {
  const subjectHash = crypto
    .createHash('sha256')
    .update(ctx.oauth.subject || '')
    .digest('hex');

  if (dataset.owner.oauthSubjectHash !== subjectHash) {
    throw new Error('Access denied: dataset ownership mismatch');
  }
}

export class InMemoryDatasetStore implements DatasetStore {
  private datasets = new Map<string, StoredDataset>();

  public async put(dataset: StoredDataset, _ttlSeconds?: number): Promise<string> {
    this.datasets.set(dataset.id, dataset);
    return dataset.id;
  }

  public async get(datasetId: string, ctx: OAuthRockContext): Promise<StoredDataset | null> {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) return null;

    // Check expiration
    if (new Date() > new Date(dataset.expiresAt)) {
      this.datasets.delete(datasetId);
      return null;
    }

    // Check ownership: ensure user can only access their own datasets
    enforceOwnership(dataset, ctx);

    return dataset;
  }

  public async delete(datasetId: string, ctx: OAuthRockContext): Promise<void> {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) return;
    enforceOwnership(dataset, ctx);
    this.datasets.delete(datasetId);
  }
}

/**
 * Redis-backed dataset store.
 * Uses Upstash Redis REST client for production caching with TTL support.
 */
export class RedisDatasetStore implements DatasetStore {
  private redis: Redis;
  private prefix: string;

  constructor(redis: Redis, prefix: string = getRedisPrefix()) {
    this.redis = redis;
    this.prefix = prefix;
  }

  public async put(dataset: StoredDataset, ttlSeconds?: number): Promise<string> {
    const key = `${this.prefix}dataset:${dataset.id}`;

    // Determine TTL: use provided value, fall back to dataset.expiresAt, or use default
    let ttl = ttlSeconds;
    if (ttl === undefined) {
      if (dataset.expiresAt) {
        const expiresAtMs = new Date(dataset.expiresAt).getTime();
        const nowMs = Date.now();
        ttl = Math.max(1, Math.floor((expiresAtMs - nowMs) / 1000));
      } else {
        ttl = parseInt(process.env.ROCK_MCP_DATASET_TTL_SECONDS || '900', 10);
      }
    }

    // Store dataset (Upstash handles JSON serialization)
    await this.redis.set(key, JSON.stringify(dataset), { ex: ttl });

    return dataset.id;
  }

  public async get(datasetId: string, ctx: OAuthRockContext): Promise<StoredDataset | null> {
    const key = `${this.prefix}dataset:${datasetId}`;

    const cached = await this.redis.get(key);
    if (!cached) return null;

    // Handle both string and object returns from Upstash
    let dataset: StoredDataset;
    if (typeof cached === 'string') {
      try {
        dataset = JSON.parse(cached);
      } catch {
        // Treat malformed/tampered entry as cache miss
        return null;
      }
    } else {
      dataset = cached as StoredDataset;
    }

    // Check expiration
    if (new Date() > new Date(dataset.expiresAt)) {
      await this.redis.del(key);
      return null;
    }

    // Check ownership: ensure user can only access their own datasets
    enforceOwnership(dataset, ctx);

    return dataset;
  }

  public async delete(datasetId: string, _ctx: OAuthRockContext): Promise<void> {
    const key = `${this.prefix}dataset:${datasetId}`;
    await this.redis.del(key);
  }
}
