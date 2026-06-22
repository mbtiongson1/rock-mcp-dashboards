import { describe, it, expect } from 'vitest';
import { isAllowedRedirectUri } from '../../src/http/register-route.js';

describe('isAllowedRedirectUri', () => {
  describe('basic validation', () => {
    it('should accept valid HTTPS URIs', () => {
      expect(isAllowedRedirectUri('https://claude.ai/auth/callback')).toBe(true);
      expect(isAllowedRedirectUri('https://example.com:8443/callback')).toBe(true);
      expect(isAllowedRedirectUri('https://sub.example.com/path')).toBe(true);
    });

    it('should accept HTTP loopback URIs', () => {
      expect(isAllowedRedirectUri('http://localhost:3000/callback')).toBe(true);
      expect(isAllowedRedirectUri('http://127.0.0.1:3000/callback')).toBe(true);
      expect(isAllowedRedirectUri('http://[::1]:3000/callback')).toBe(true);
      expect(isAllowedRedirectUri('http://[::1]/callback')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(isAllowedRedirectUri('not a url')).toBe(false);
      expect(isAllowedRedirectUri('example.com/callback')).toBe(false);
      expect(isAllowedRedirectUri('')).toBe(false);
    });

    it('should reject HTTP non-loopback URIs', () => {
      expect(isAllowedRedirectUri('http://example.com/callback')).toBe(false);
      expect(isAllowedRedirectUri('http://10.0.0.1/callback')).toBe(false);
    });

    it('should reject unsupported schemes', () => {
      expect(isAllowedRedirectUri('ftp://example.com/callback')).toBe(false);
      expect(isAllowedRedirectUri('data:text/html,<h1>test</h1>')).toBe(false);
      expect(isAllowedRedirectUri('file:///etc/passwd')).toBe(false);
    });
  });

  describe('fragment rejection', () => {
    it('should reject URIs with fragments', () => {
      expect(isAllowedRedirectUri('https://example.com/callback#token')).toBe(false);
      expect(isAllowedRedirectUri('https://example.com#section')).toBe(false);
      expect(isAllowedRedirectUri('http://localhost:3000/callback#')).toBe(false);
    });

    it('should accept URIs without fragments', () => {
      expect(isAllowedRedirectUri('https://example.com/callback')).toBe(true);
      expect(isAllowedRedirectUri('http://localhost/callback')).toBe(true);
    });
  });

  describe('credential rejection', () => {
    it('should reject URIs with embedded credentials', () => {
      expect(isAllowedRedirectUri('https://user:pass@example.com/callback')).toBe(false);
      expect(isAllowedRedirectUri('https://user@example.com/callback')).toBe(false);
      expect(isAllowedRedirectUri('http://user:pass@localhost:3000/callback')).toBe(false);
    });

    it('should accept URIs without credentials', () => {
      expect(isAllowedRedirectUri('https://example.com/user:pass')).toBe(true); // :pass in path is ok
      expect(isAllowedRedirectUri('https://example.com/callback?user=john&pass=secret')).toBe(true); // query params ok
    });
  });

  describe('optional allowlist', () => {
    it('should allow all HTTPS when allowlist is empty', () => {
      expect(isAllowedRedirectUri('https://example.com/callback', '')).toBe(true);
      expect(isAllowedRedirectUri('https://any-domain.com/callback', '')).toBe(true);
    });

    it('should allow specific domains in allowlist', () => {
      const allowList = 'claude.ai, cursor.sh, example.com';
      expect(isAllowedRedirectUri('https://claude.ai/callback', allowList)).toBe(true);
      expect(isAllowedRedirectUri('https://cursor.sh/callback', allowList)).toBe(true);
      expect(isAllowedRedirectUri('https://example.com/callback', allowList)).toBe(true);
    });

    it('should allow subdomains when domain is in allowlist', () => {
      const allowList = 'example.com';
      expect(isAllowedRedirectUri('https://api.example.com/callback', allowList)).toBe(true);
      expect(isAllowedRedirectUri('https://auth.api.example.com/callback', allowList)).toBe(true);
    });

    it('should reject domains not in allowlist', () => {
      const allowList = 'claude.ai, cursor.sh';
      expect(isAllowedRedirectUri('https://example.com/callback', allowList)).toBe(false);
      expect(isAllowedRedirectUri('https://other.com/callback', allowList)).toBe(false);
    });

    it('should be case-insensitive', () => {
      const allowList = 'Claude.AI, Example.COM';
      expect(isAllowedRedirectUri('https://claude.ai/callback', allowList)).toBe(true);
      expect(isAllowedRedirectUri('https://CLAUDE.AI/callback', allowList)).toBe(true);
      expect(isAllowedRedirectUri('https://example.com/callback', allowList)).toBe(true);
      expect(isAllowedRedirectUri('https://EXAMPLE.COM/callback', allowList)).toBe(true);
    });

    it('should trim whitespace in allowlist', () => {
      const allowList = '  claude.ai  ,  example.com  ';
      expect(isAllowedRedirectUri('https://claude.ai/callback', allowList)).toBe(true);
      expect(isAllowedRedirectUri('https://example.com/callback', allowList)).toBe(true);
    });

    it('should still allow HTTP loopback regardless of allowlist', () => {
      const allowList = 'claude.ai, example.com';
      expect(isAllowedRedirectUri('http://localhost:3000/callback', allowList)).toBe(true);
      expect(isAllowedRedirectUri('http://127.0.0.1:8080/callback', allowList)).toBe(true);
    });

    it('should reject HTTP non-loopback even if in allowlist', () => {
      const allowList = 'example.com';
      expect(isAllowedRedirectUri('http://example.com/callback', allowList)).toBe(false);
    });
  });
});
