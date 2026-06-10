import { describe, it, expect } from 'vitest';
// @ts-ignore
import { resolveServerOverride } from './server-override.js';

const DEFAULT_BASE = 'https://rock.example.com';

describe('resolveServerOverride', () => {
  it('allows the default host', () => {
    const result = resolveServerOverride('rock.example.com', DEFAULT_BASE);
    expect(result).toEqual({ ok: true, baseUrl: 'https://rock.example.com', host: 'rock.example.com' });
  });

  it('allows sibling hosts on the same parent domain', () => {
    const result = resolveServerOverride('rock-preview.example.com', DEFAULT_BASE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('https://rock-preview.example.com');
  });

  it('accepts a full https URL and normalizes to the host', () => {
    const result = resolveServerOverride('https://rock-preview.example.com', DEFAULT_BASE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('https://rock-preview.example.com');
  });

  it('rejects hosts outside the parent domain', () => {
    const result = resolveServerOverride('evil.com', DEFAULT_BASE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not an allowed Rock host');
  });

  it('rejects lookalike suffixes without a dot boundary', () => {
    const result = resolveServerOverride('notexample.com', DEFAULT_BASE);
    expect(result.ok).toBe(false);
  });

  it('rejects http, credentials, ports, and paths', () => {
    expect(resolveServerOverride('http://rock.example.com', DEFAULT_BASE).ok).toBe(false);
    expect(resolveServerOverride('user:pass@rock.example.com', DEFAULT_BASE).ok).toBe(false);
    expect(resolveServerOverride('rock.example.com:8080', DEFAULT_BASE).ok).toBe(false);
    expect(resolveServerOverride('rock.example.com/path', DEFAULT_BASE).ok).toBe(false);
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
