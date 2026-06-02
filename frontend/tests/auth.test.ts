import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  establishSession,
  AuthError,
  logout,
  getStoredToken,
  setStoredToken,
  clearStoredToken,
} from '../src/api/auth';

/** fetch スタブ。Response 風を返す。 */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  clearStoredToken();
});

describe('establishSession (ID-only, POST /api/auth/session, A-33 token)', () => {
  it('id を送り {ok,isAdmin,token,label} を返す(cookie廃止)', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ok: true, isAdmin: true, token: 'tk-1', label: 'Admin' }),
      );
    const res = await establishSession('phi-1', {}, f as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, isAdmin: true, token: 'tk-1', label: 'Admin' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/auth/session');
    expect(init.method).toBe('POST');
    // cookie 廃止: credentials:'include' は不要(送らない)
    expect(init.credentials).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.id).toBe('phi-1');
    // パスワード廃止: body に password を含めない
    expect('password' in body).toBe(false);
  });

  it('remember:true で body.remember=true を送る', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, isAdmin: false, token: 'tk' }));
    await establishSession('phi-1', { remember: true }, f as unknown as typeof fetch);
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.remember).toBe(true);
  });

  it('label 指定で body.label を送る', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, isAdmin: false, token: 'tk' }));
    await establishSession(
      'phi-1',
      { remember: true, label: 'Hero' },
      f as unknown as typeof fetch,
    );
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.label).toBe('Hero');
  });

  it('remember 未指定では remember を送らない', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, isAdmin: false, token: 'tk' }));
    await establishSession('phi-1', {}, f as unknown as typeof fetch);
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect('remember' in body).toBe(false);
  });

  it('isAdmin 欠落時は false に正規化', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true, token: 'tk' }));
    const res = await establishSession('phi-1', {}, f as unknown as typeof fetch);
    expect(res.isAdmin).toBe(false);
  });

  it('token 欠落時は AuthError を throw', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true, isAdmin: true }));
    await expect(
      establishSession('phi-1', {}, f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('HTTP 失敗 + error で AuthError を throw', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: 'AUTH_FAILED', message: '不正なID' } },
        { ok: false, status: 401 },
      ),
    );
    await expect(
      establishSession('bad', {}, f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('ok:false で AuthError を throw', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: false }));
    await expect(
      establishSession('bad', {}, f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe('token storage (A-33)', () => {
  it('set/get/clear が localStorage に反映', () => {
    expect(getStoredToken()).toBeNull();
    setStoredToken('tk-x');
    expect(getStoredToken()).toBe('tk-x');
    clearStoredToken();
    expect(getStoredToken()).toBeNull();
  });
});

describe('logout (A-33)', () => {
  it('Bearer 付きで /api/auth/logout を叩き token をクリア', async () => {
    setStoredToken('tk-x');
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await logout('tk-x', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tk-x');
    expect(getStoredToken()).toBeNull();
  });

  it('BE 失敗でも token は必ずクリア', async () => {
    setStoredToken('tk-x');
    const f = vi.fn().mockRejectedValue(new Error('network'));
    await logout('tk-x', f as unknown as typeof fetch);
    expect(getStoredToken()).toBeNull();
  });

  it('token 無しなら fetch を呼ばず clear のみ', async () => {
    const f = vi.fn();
    await logout(null, f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
  });
});
