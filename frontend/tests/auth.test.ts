import { describe, it, expect, vi } from 'vitest';
import { establishSession, AuthError } from '../src/api/auth';

/** fetch スタブ。Response 風を返す。 */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe('establishSession (ID-only, POST /api/auth/session)', () => {
  it('id を送り {ok,isAdmin,label} を返す(credentials:include)', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, isAdmin: true, label: 'Admin' }));
    const res = await establishSession('phi-1', {}, f as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, isAdmin: true, label: 'Admin' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/auth/session');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const body = JSON.parse(init.body);
    expect(body.id).toBe('phi-1');
    // パスワード廃止: body に password を含めない
    expect('password' in body).toBe(false);
  });

  it('remember:true で body.remember=true を送る', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true, isAdmin: false }));
    await establishSession('phi-1', { remember: true }, f as unknown as typeof fetch);
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.remember).toBe(true);
  });

  it('remember 未指定では remember を送らない', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true, isAdmin: false }));
    await establishSession('phi-1', {}, f as unknown as typeof fetch);
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect('remember' in body).toBe(false);
  });

  it('isAdmin 欠落時は false に正規化', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const res = await establishSession('phi-1', {}, f as unknown as typeof fetch);
    expect(res.isAdmin).toBe(false);
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
