import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listAccounts,
  setAdmin,
  forcePassword,
  deleteAccount,
  AdminError,
} from '../src/api/admin';
import { setStoredToken, clearStoredToken } from '../src/api/auth';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => clearStoredToken());

describe('admin accounts API', () => {
  it('listAccounts は accounts 配列を返す', async () => {
    setStoredToken('tk');
    const accounts = [{ accountId: 'a', isAdmin: true, createdAt: 't', charCount: 2 }];
    const f = vi.fn().mockResolvedValue(jsonResponse({ accounts }));
    const res = await listAccounts(f as unknown as typeof fetch);
    expect(res).toEqual(accounts);
    expect(f.mock.calls[0][0]).toBe('/api/admin/accounts');
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tk' });
  });

  it('setAdmin は value を POST', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ accountId: 'a', isAdmin: false }));
    await setAdmin('a', false, f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/accounts/a/admin');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ value: false });
  });

  it('forcePassword は password を PUT', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await forcePassword('a', 'newpassw0rd', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/accounts/a/password');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ password: 'newpassw0rd' });
  });

  it('deleteAccount は DELETE', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await deleteAccount('a', f as unknown as typeof fetch);
    expect(f.mock.calls[0][0]).toBe('/api/admin/accounts/a');
    expect((f.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('安全弁 400 を message 付き AdminError に', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ detail: '最後の管理者は削除できません' }, { ok: false, status: 400 }));
    await expect(deleteAccount('a', f as unknown as typeof fetch))
      .rejects.toMatchObject({ message: '最後の管理者は削除できません', status: 400 });
    await expect(deleteAccount('a', f as unknown as typeof fetch)).rejects.toBeInstanceOf(AdminError);
  });
});
