import * as crypto from 'crypto';
import { OAuthRockContext } from '../http/oauth.js';

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

export class InMemoryDatasetStore {
  private datasets = new Map<string, StoredDataset>();

  public async put(dataset: StoredDataset): Promise<string> {
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
    const subjectHash = crypto
      .createHash('sha256')
      .update(ctx.oauth.subject || '')
      .digest('hex');

    if (dataset.owner.oauthSubjectHash !== subjectHash) {
      throw new Error('Access denied: dataset ownership mismatch');
    }

    return dataset;
  }

  public async delete(datasetId: string, _ctx: OAuthRockContext): Promise<void> {
    this.datasets.delete(datasetId);
  }
}
