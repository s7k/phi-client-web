import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  register,
  login,
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

describe('register (POST /api/auth/register, A-34)', () => {
  it('accountId+password を送り {ok:true} を返す', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const res = await register('acc-1', 'pw', f as unknown as typeof fetch);
    expect(res).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/auth/register');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.accountId).toBe('acc-1');
    expect(body.password).toBe('pw');
  });

  it('409(既存)で AuthError(code=CONFLICT, status=409)', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 'CONFLICT', message: '既存' } }, { ok: false, status: 409 }),
    );
    await expect(
      register('acc-1', 'pw', f as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });

  it('その他 HTTP 失敗で AuthError', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));
    await expect(
      register('acc-1', 'pw', f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe('login (POST /api/auth/login, A-34)', () => {
  it('accountId+password を送り {ok,token,isAdmin} を返す', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, token: 'tk-1', isAdmin: true }));
    const res = await login('acc-1', 'pw', f as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, token: 'tk-1', isAdmin: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.accountId).toBe('acc-1');
    expect(body.password).toBe('pw');
  });

  it('isAdmin 欠落時は false に正規化', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true, token: 'tk' }));
    const res = await login('acc-1', 'pw', f as unknown as typeof fetch);
    expect(res.isAdmin).toBe(false);
  });

  it('token 欠落時は AuthError を throw', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true, isAdmin: true }));
    await expect(
      login('acc-1', 'pw', f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('HTTP 失敗 + error で AuthError を throw', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: 'AUTH_FAILED', message: '不正な資格情報' } },
        { ok: false, status: 401 },
      ),
    );
    await expect(
      login('bad', 'bad', f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('ok:false で AuthError を throw', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: false }));
    await expect(
      login('bad', 'bad', f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe('token storage (A-33/A-34)', () => {
  it('set/get/clear が localStorage に反映', () => {
    expect(getStoredToken()).toBeNull();
    setStoredToken('tk-x');
    expect(getStoredToken()).toBe('tk-x');
    clearStoredToken();
    expect(getStoredToken()).toBeNull();
  });
});

describe('logout (A-33/A-34)', () => {
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
