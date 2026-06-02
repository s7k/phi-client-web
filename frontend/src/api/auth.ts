/**
 * アカウント認証 REST クライアント(A-34)。
 *
 * 1アカウント(accountId+password)の下に複数キャラ(charId)構造へ再設計。
 * 旧 ID-only / establishSession は撤去。
 *
 * - POST /api/auth/register {accountId, password} → {ok}(409=既存)。
 * - POST /api/auth/login {accountId, password} → {ok, token, isAdmin}。
 *   成功で token を localStorage 保存し、以後 REST(Bearer)/WS auth(`{type:"auth",token}`)に使う。
 * - POST /api/auth/logout(Bearer)。
 *
 * 注: password / token は資格情報。ここでログ出力しない(漏洩防止)。
 */

/** localStorage に token を保存するキー。 */
export const TOKEN_KEY = 'phi_token';

/** localStorage を解決(globalThis 優先、無ければ window フォールバック)。 */
function resolveStorage(): Storage | null {
  const g = globalThis as { localStorage?: Storage; window?: { localStorage?: Storage } };
  return g.localStorage ?? g.window?.localStorage ?? null;
}

/** localStorage から token を取得(SSR/未対応環境では null)。 */
export function getStoredToken(): string | null {
  try {
    return resolveStorage()?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

/** token を localStorage へ保存。 */
export function setStoredToken(token: string): void {
  try {
    resolveStorage()?.setItem(TOKEN_KEY, token);
  } catch {
    /* localStorage 不可環境は無視(メモリ保持のみ) */
  }
}

/** localStorage の token を破棄(ログアウト)。 */
export function clearStoredToken(): void {
  try {
    resolveStorage()?.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

/** POST /api/auth/login 成功応答(A-34)。 */
export interface LoginResult {
  ok: true;
  /** 認証トークン(localStorage 保存 → REST Bearer / WS auth)。 */
  token: string;
  /** 管理者アカウントか(管理UI出し分け)。 */
  isAdmin: boolean;
}

/** REST 失敗を表す例外。code で 409(既存)等を区別。 */
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'AUTH_FAILED', status = 0) {
    super(message);
    this.name = 'AuthError';
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

/**
 * アカウント新規登録(A-34)。POST /api/auth/register {accountId, password}。
 * 成功で {ok:true}。409(既存アカウント)は AuthError(code='CONFLICT', status=409)。
 */
export async function register(
  accountId: string,
  password: string,
  fetchImpl?: FetchLike,
): Promise<{ ok: true }> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accountId, password }),
  });
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: { code?: string; message?: string } }
    | null;
  if (res.status === 409) {
    throw new AuthError(
      data?.error?.message ?? 'このアカウントIDは既に使用されています',
      data?.error?.code ?? 'CONFLICT',
      409,
    );
  }
  if (!res.ok || !data || data.ok === false || data.error) {
    throw new AuthError(
      data?.error?.message ?? `登録に失敗しました (HTTP ${res.status})`,
      data?.error?.code ?? 'AUTH_FAILED',
      res.status,
    );
  }
  return { ok: true };
}

/**
 * ログイン(A-34)。POST /api/auth/login {accountId, password} → {ok, token, isAdmin}。
 * 成功で {ok, token, isAdmin}。失敗は AuthError を throw。
 * token は呼び出し側(controller)が localStorage 保存し WS auth に使う。
 */
export async function login(
  accountId: string,
  password: string,
  fetchImpl?: FetchLike,
): Promise<LoginResult> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accountId, password }),
  });
  const data = (await res.json().catch(() => null)) as
    | {
        ok?: boolean;
        isAdmin?: boolean;
        token?: string;
        error?: { code?: string; message?: string };
      }
    | null;
  if (!res.ok || !data || data.ok === false || data.error || !data.token) {
    throw new AuthError(
      data?.error?.message ?? `ログインに失敗しました (HTTP ${res.status})`,
      data?.error?.code ?? 'AUTH_FAILED',
      res.status,
    );
  }
  return { ok: true, token: data.token, isAdmin: !!data.isAdmin };
}

/**
 * ログアウト(A-34)。BE に Bearer 付きで通知し token を破棄。
 * BE 失敗でも localStorage は必ずクリアする(ローカル状態優先)。
 */
export async function logout(
  token: string | null = getStoredToken(),
  fetchImpl?: FetchLike,
): Promise<void> {
  try {
    if (token) {
      const f = resolveFetch(fetchImpl);
      await f('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }).catch(() => null);
    }
  } finally {
    clearStoredToken();
  }
}
