import { describe, it, expect } from 'vitest';
// @ts-ignore
import { resolveServerOverride } from '../../src/http/server-override.js';

const DEFAULT_BASE = 'https://rock.example.com';

describe('resolveServerOverride', () => {
  it('allows the default host', () => {
    const result = resolveServerOverride('rock.example.com', DEFAULT_BASE);
    expect(result).toEqual({ ok: true, baseUrl: 'https://rock.example.com', host: 'rock.example.com' });
  });

  it('no longer trusts arbitrary siblings of the default host parent domain (implicit wildcard removed)', () => {
    // Previously rock-preview.example.com was allowed by deriving the parent of
    // the default host. That implicit wildcard is gone: only the default host,
    // the env allowlist, and the legacy favor.church domain are accepted.
    const result = resolveServerOverride('rock-preview.example.com', DEFAULT_BASE);
    expect(result.ok).toBe(false);
  });

  it('allows *.favor.church for backwards compatibility regardless of the default host', () => {
    const result = resolveServerOverride('rock-preview.favor.church', DEFAULT_BASE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('https://rock-preview.favor.church');
  });

  it('allows the favor.church apex (legacy)', () => {
    const result = resolveServerOverride('favor.church', DEFAULT_BASE);
    expect(result.ok).toBe(true);
  });

  it('still allows favor.church hosts even when an env allowlist is configured', () => {
    const result = resolveServerOverride('rock.favor.church', DEFAULT_BASE, 'rock.other.org');
    expect(result.ok).toBe(true);
  });

  it('accepts a full https URL and normalizes to the host', () => {
    const result = resolveServerOverride('https://rock-preview.favor.church', DEFAULT_BASE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('https://rock-preview.favor.church');
  });

  it('rejects unrelated hosts', () => {
    const result = resolveServerOverride('evil.com', DEFAULT_BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not an allowed Rock host');
  });

  it('rejects favor.church lookalikes without a dot boundary', () => {
    // notfavor.church ends with "favor.church" but NOT ".favor.church".
    const result = resolveServerOverride('notfavor.church', DEFAULT_BASE);
    expect(result.ok).toBe(false);
  });

  it('rejects http, credentials, ports, and paths', () => {
    expect(resolveServerOverride('http://rock.favor.church', DEFAULT_BASE).ok).toBe(false);
    expect(resolveServerOverride('user:pass@rock.favor.church', DEFAULT_BASE).ok).toBe(false);
    expect(resolveServerOverride('rock.favor.church:8080', DEFAULT_BASE).ok).toBe(false);
    expect(resolveServerOverride('rock.favor.church/path', DEFAULT_BASE).ok).toBe(false);
    expect(resolveServerOverride('', DEFAULT_BASE).ok).toBe(false);
  });

  it('allows hosts from the ROCK_ALLOWED_SERVERS env list', () => {
    const result = resolveServerOverride('rock.other.org', DEFAULT_BASE, 'rock.other.org, alt.example.net');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('https://rock.other.org');
  });

  it('still rejects unlisted hosts when an env list is present', () => {
    const result = resolveServerOverride('bad.other.org', DEFAULT_BASE, 'rock.other.org');
    expect(result.ok).toBe(false);
  });
});
