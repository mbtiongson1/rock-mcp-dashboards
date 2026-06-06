import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
// @ts-ignore
import { createAuthMiddleware } from './oauth.js';

describe('OAuth Middleware', () => {
  it('should return 401 when Authorization header is missing', async () => {
    const middleware = createAuthMiddleware({
      verifyToken: async () => ({ isValid: false, error: 'Missing token' }),
    });

    const req = { headers: {} } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 403 when read scope is missing', async () => {
    const middleware = createAuthMiddleware({
      verifyToken: async () => ({
        isValid: true,
        payload: { sub: 'user123', scope: 'other' }
      }),
    });

    const req = { headers: { authorization: 'Bearer token' } } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Missing required read scope' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('should succeed and attach oauthContext when token and read scope are valid', async () => {
    const middleware = createAuthMiddleware({
      verifyToken: async () => ({
        isValid: true,
        payload: { sub: 'user123', scope: 'read write', email: 'test@example.com' }
      }),
    });

    const req = {
      headers: { authorization: 'Bearer token' },
      ip: '127.0.0.1',
      headers_info: { 'user-agent': 'vitest' }
    } as unknown as Request & { oauthContext?: any };
    
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.oauthContext).toBeDefined();
    expect(req.oauthContext.oauth.subject).toBe('user123');
    expect(req.oauthContext.scopes).toContain('read');
    expect(req.oauthContext.scopes).toContain('write');
  });
});
