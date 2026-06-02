/**
 * ID-only ログイン REST クライアント([07]§5.1, A-33 token ベース)。
 *
 * - POST /api/auth/session {id, remember?, label?} → {ok, isAdmin, token, label?}。
 *   成功で BE が認証トークンを発行(cookie 廃止)。
 *   FE は token を localStorage へ保存し、以後の REST(Authorization: Bearer)/
 *   WS 認証(`{type:"auth", token}`)に使う。
 *   これがログインの実体(別パスワードは廃止。PHI ID 自体が資格情報)。
 *
 * 注: PHI ID / token は資格情報。ここでログ出力しない(漏洩防止)。
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

/** POST /api/auth/session 成功応答([07]§5.1, A-33)。 */
export interface SessionAuthResult {
  ok: true;
  /** 管理者IDか(管理UI出し分け)。 */
  isAdmin: boolean;
  /** 認証トークン(localStorage 保存 → REST Bearer / WS auth)。 */
  token: string;
  /** 表示用ラベル(BEが付与する場合)。 */
  label?: string;
}

/** REST 失敗を表す例外。 */
export class AuthError extends Error {
  readonly code: string;
  constructor(message: string, code = 'AUTH_FAILED') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

type FetchLike = typeof fetch;

function resolveFetch(f?: FetchLike): FetchLike {
  const fn = f ?? globalThis.fetch;
  if (!fn) throw new Error('fetch が利用できません');
  return fn;
}

/**
 * セッション確立(ログイン, A-33)。PHI ID を送り token を発行させる。
 * 成功で {ok, isAdmin, token, label?}。失敗は AuthError を throw。
 * cookie は使わない(token を localStorage 保存し以後 Bearer/WS auth に使う)。
 * @param opts.remember true で BE にこのIDの保存を依頼(saved.list に載る)。
 * @param opts.label remember 時の保存ラベル(任意)。
 */
export async function establishSession(
  id: string,
  opts: { remember?: boolean; label?: string } = {},
  fetchImpl?: FetchLike,
): Promise<SessionAuthResult> {
  const f = resolveFetch(fetchImpl);
  const body: { id: string; remember?: boolean; label?: string } = { id };
  if (opts.remember) body.remember = true;
  if (opts.label !== undefined) body.label = opts.label;
  const res = await f('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | {
        ok?: boolean;
        isAdmin?: boolean;
        token?: string;
        label?: string;
        error?: { code?: string; message?: string };
      }
    | null;

  if (!res.ok || !data || data.ok === false || data.error || !data.token) {
    const msg = data?.error?.message ?? `認証に失敗しました (HTTP ${res.status})`;
    throw new AuthError(msg, data?.error?.code ?? 'AUTH_FAILED');
  }
  return { ok: true, isAdmin: !!data.isAdmin, token: data.token, label: data.label };
}

/**
 * ログアウト(A-33)。BE に Bearer 付きで通知し token を破棄。
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
