import * as crypto from 'crypto';
import type { Redis } from '@upstash/redis';
import { getRedisPrefix } from '../rock/redis.js';

/**
 * Redis-backed state for the OAuth authorization-server proxy:
 * - connector registrations (DCR) — persistent
 * - pending authorize transactions — 10 minute TTL
 * - one-time proxy authorization codes — 60 second TTL, deleted on consume
 *
 * Falls back to an in-memory store when Redis is not configured (single
 * instance dev only — serverless deployments must configure Redis or the
 * authorize → callback → token hops may land on different instances).
 */

export interface ConnectorRegistration {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

export interface PendingAuthTransaction {
  clientId: string;
  redirectUri: string;
  connectorState?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope?: string;
  createdAt: number;
}

export interface ProxyCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  /** Auth0 token response, returned to the connector verbatim. */
  tokenResponse: Record<string, unknown>;
  createdAt: number;
}

export const TRANSACTION_TTL_SECONDS = 600;
export const PROXY_CODE_TTL_SECONDS = 60;
export const CLIENT_REGISTRATION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Rate limiting for DCR: 10 registrations per IP per hour
export const DCR_RATE_LIMIT_REQUESTS = 10;
export const DCR_RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour

interface MemoryEntry {
  value: unknown;
  expiresAt?: number;
}

export class OAuthTransactionStore {
  private prefix: string;
  private memory = new Map<string, MemoryEntry>();

  constructor(private redis: Redis | null, prefix: string = getRedisPrefix()) {
    this.prefix = prefix;
  }

  public async registerClient(redirectUris: string[], clientName?: string): Promise<ConnectorRegistration> {
    const registration: ConnectorRegistration = {
      clientId: `mcp_${randomToken(24)}`,
      redirectUris,
      clientName,
      createdAt: Date.now(),
    };
    await this.set(this.clientKey(registration.clientId), registration, CLIENT_REGISTRATION_TTL_SECONDS);
    return registration;
  }

  public async getClient(clientId: string): Promise<ConnectorRegistration | null> {
    if (!clientId || !clientId.startsWith('mcp_')) {
      return null;
    }
    return this.get<ConnectorRegistration>(this.clientKey(clientId));
  }

  /**
   * Refreshes the TTL on a client registration when it's actively used (e.g., on successful
   * authorize). This keeps active clients from expiring while preventing registration bloat.
   */
  public async touchClient(clientId: string): Promise<void> {
    const registration = await this.getClient(clientId);
    if (registration) {
      await this.set(this.clientKey(clientId), registration, CLIENT_REGISTRATION_TTL_SECONDS);
    }
  }

  public async createTransaction(txn: Omit<PendingAuthTransaction, 'createdAt'>): Promise<string> {
    const state = randomToken(32);
    await this.set(
      this.txnKey(state),
      { ...txn, createdAt: Date.now() } satisfies PendingAuthTransaction,
      TRANSACTION_TTL_SECONDS
    );
    return state;
  }

  /** Returns and deletes the pending transaction — each state is single-use. */
  public async consumeTransaction(state: string): Promise<PendingAuthTransaction | null> {
    return this.getDel<PendingAuthTransaction>(this.txnKey(state));
  }

  public async createProxyCode(record: Omit<ProxyCodeRecord, 'createdAt'>): Promise<string> {
    const code = randomToken(32);
    await this.set(
      this.codeKey(code),
      { ...record, createdAt: Date.now() } satisfies ProxyCodeRecord,
      PROXY_CODE_TTL_SECONDS
    );
    return code;
  }

  /** Returns and deletes the code record — proxy codes are one-time use. */
  public async consumeProxyCode(code: string): Promise<ProxyCodeRecord | null> {
    return this.getDel<ProxyCodeRecord>(this.codeKey(code));
  }

  private clientKey(clientId: string): string {
    return `${this.prefix}oauth:client:${clientId}`;
  }

  private txnKey(state: string): string {
    return `${this.prefix}oauth:txn:${state}`;
  }

  private codeKey(code: string): string {
    return `${this.prefix}oauth:code:${code}`;
  }

  private async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (this.redis) {
      if (ttlSeconds) {
        await this.redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
      } else {
        await this.redis.set(key, JSON.stringify(value));
      }
      return;
    }
    this.memory.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  private async get<T>(key: string): Promise<T | null> {
    if (this.redis) {
      return parseStored<T>(await this.redis.get(key));
    }
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.memory.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private async getDel<T>(key: string): Promise<T | null> {
    if (this.redis) {
      return parseStored<T>(await this.redis.getdel(key));
    }
    const value = await this.get<T>(key);
    this.memory.delete(key);
    return value;
  }
}

function parseStored<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  // @upstash/redis may deserialize JSON automatically depending on client config.
  if (typeof raw === 'object') {
    return raw as T;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
