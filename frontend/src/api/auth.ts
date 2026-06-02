/**
 * ID-only ログイン REST クライアント([07]§5.1)。
 *
 * - POST /api/auth/session {id} → {ok, isAdmin, label?}。
 *   成功で BE がセッション cookie を発行(以後の WS / REST に付与)。
 *   これがログインの実体(別パスワードは廃止。PHI ID 自体が資格情報)。
 *
 * 注: PHI ID は資格情報。ここでログ出力しない(漏洩防止)。
 */

/** POST /api/auth/session 成功応答([07]§5.1)。 */
export interface SessionAuthResult {
  ok: true;
  /** 管理者IDか(管理UI出し分け)。 */
  isAdmin: boolean;
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
 * セッション確立(ログイン)。PHI ID を送り cookie を発行させる。
 * 成功で {ok, isAdmin, label?}。失敗は AuthError を throw。
 * credentials:'include' で cookie 受領を保証。
 * @param opts.remember true で BE にこのIDの保存を依頼(saved.list に載る)。
 */
export async function establishSession(
  id: string,
  opts: { remember?: boolean } = {},
  fetchImpl?: FetchLike,
): Promise<SessionAuthResult> {
  const f = resolveFetch(fetchImpl);
  const body: { id: string; remember?: boolean } = { id };
  if (opts.remember) body.remember = true;
  const res = await f('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; isAdmin?: boolean; label?: string; error?: { code?: string; message?: string } }
    | null;

  if (!res.ok || !data || data.ok === false || data.error) {
    const msg = data?.error?.message ?? `認証に失敗しました (HTTP ${res.status})`;
    throw new AuthError(msg, data?.error?.code ?? 'AUTH_FAILED');
  }
  return { ok: true, isAdmin: !!data.isAdmin, label: data.label };
}
