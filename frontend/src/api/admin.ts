/**
 * 管理者ユーザ管理 REST クライアント(/api/admin)。
 *
 * アカウント一覧・管理者付与/剥奪・パスワード強制変更・削除。全 API は Bearer 必須
 * (BE 側 require_admin で管理者限定)。安全弁(自己/最後の管理者保護)は BE が 400 で返す。
 * password は資格情報のためログ出力しない。
 */
import { getStoredToken } from './auth';

export interface AdminAccount {
  accountId: string;
  isAdmin: boolean;
  createdAt: string;
  charCount: number;
}

export class AdminError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'BAD_REQUEST', status = 0) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
    this.status = status;
  }
}

type FetchLike = typeof fetch;

function resolveFetch(f?: FetchLike): FetchLike {
  const fn = f ?? globalThis.fetch;
  if (!fn) throw new Error('fetch が利用できません');
  return fn;
}

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = getStoredToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

async function readError(res: Response): Promise<AdminError> {
  const data = (await res.json().catch(() => null)) as
    | { detail?: string; error?: { code?: string; message?: string } }
    | null;
  const msg =
    data?.error?.message ?? data?.detail ?? `要求に失敗しました (HTTP ${res.status})`;
  return new AdminError(msg, data?.error?.code ?? 'BAD_REQUEST', res.status);
}

export async function listAccounts(fetchImpl?: FetchLike): Promise<AdminAccount[]> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/admin/accounts', { headers: authHeaders({ Accept: 'application/json' }) });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as { accounts?: AdminAccount[] };
  return data.accounts ?? [];
}

export async function setAdmin(
  accountId: string,
  value: boolean,
  fetchImpl?: FetchLike,
): Promise<void> {
  const f = resolveFetch(fetchImpl);
  const res = await f(`/api/admin/accounts/${encodeURIComponent(accountId)}/admin`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw await readError(res);
}

export async function forcePassword(
  accountId: string,
  password: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const f = resolveFetch(fetchImpl);
  const res = await f(`/api/admin/accounts/${encodeURIComponent(accountId)}/password`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await readError(res);
}

export async function deleteAccount(accountId: string, fetchImpl?: FetchLike): Promise<void> {
  const f = resolveFetch(fetchImpl);
  const res = await f(`/api/admin/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw await readError(res);
}
