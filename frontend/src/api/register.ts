/**
 * F12 登録REST クライアント([12]§2.3)。
 *
 * - GET  /api/register/graphics?host=&port= → 登録先サーバの初期グラ一覧(BEが`#ex-get REGINFO IMG`)。
 * - POST /api/register {host, port, name, pass?(6), imageIndex, mail?} → BEが`#ex-register`代行。
 *   成功: {charId, name} / 失敗: {detail:{error:{code:"REGISTER_REJECT", fields:[...]}}}。
 *
 * fetch ベース。テストでは fetch を差し替え可。
 * 保護APIは Authorization: Bearer <token>(localStorage)を付与(A-33)。
 */
import { getStoredToken } from './auth';

/** 初期グラ1件。BEは順序付きで返す(索引=配列位置 = `#ex-register image=`)。 */
export interface RegisterGraphic {
  /** init_graphic[] の索引(0〜)。image= に送る値。 */
  index: number;
  /** グラ名(拡張子なし、Index.txt 解決用)。 */
  gra: string;
}

/** POST /api/register リクエストボディ([12]§2.3)。 */
export interface RegisterRequestBody {
  /** 登録先サーバ。作成したキャラはこの host:port で characters に入る。 */
  host: string;
  port: number;
  name: string;
  /** 正確に6文字([12]§2.1)。省略時は BE がランダムに決める。 */
  pass?: string;
  /** 初期グラ索引(graphics 配列位置)。 */
  imageIndex: number;
  /** メール(任意)。 */
  mail?: string;
}

/** 成功レスポンス([12]§2.3)。 */
export interface RegisterSuccess {
  charId: string;
  name: string;
}

/** reject 等のエラー詳細([12]§2.3)。fields に欠陥項目を列挙。 */
export interface RegisterErrorDetail {
  code: 'REGISTER_REJECT' | (string & {});
  message?: string;
  /** 欠陥フィールド("name"|"pass"|"image"|"mail")。 */
  fields?: string[];
}

/** REST 失敗を表す例外。fields でフィールド別エラー表示に使う。 */
export class RegisterError extends Error {
  readonly code: string;
  readonly fields: string[];
  constructor(detail: RegisterErrorDetail) {
    super(detail.message ?? '登録に失敗しました');
    this.name = 'RegisterError';
    this.code = detail.code;
    this.fields = detail.fields ?? [];
  }
}

type FetchLike = typeof fetch;

function resolveFetch(f?: FetchLike): FetchLike {
  const fn = f ?? globalThis.fetch;
  if (!fn) throw new Error('fetch が利用できません');
  return fn;
}

/** 保護 REST 用の Authorization ヘッダ(token あれば Bearer 付与, A-33)。 */
function authHeaders(base: Record<string, string>): Record<string, string> {
  const token = getStoredToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

/**
 * 初期グラ一覧取得。
 * BE応答は `{graphics: [{index, graName}]}`。
 */
export async function fetchRegisterGraphics(
  host: string,
  port: number,
  fetchImpl?: FetchLike,
): Promise<RegisterGraphic[]> {
  const f = resolveFetch(fetchImpl);
  const q = new URLSearchParams({ host, port: String(port) });
  const res = await f(`/api/register/graphics?${q}`, {
    method: 'GET',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) {
    throw new Error(`グラ一覧取得に失敗しました (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { graphics?: { index: number; graName: string }[] };
  return (body.graphics ?? []).map((g) => ({ index: g.index, gra: g.graName }));
}

/**
 * 登録実行。成功で {charId, name}。
 * reject(HTTP 4xx + error.code)時は RegisterError(fields付き)を throw。
 */
export async function postRegister(
  body: RegisterRequestBody,
  fetchImpl?: FetchLike,
): Promise<RegisterSuccess> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/register', {
    method: 'POST',
    headers: authHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (Partial<RegisterSuccess> & { detail?: string | { error?: RegisterErrorDetail } })
    | null;

  if (!res.ok) {
    // FastAPI の HTTPException は {detail: ...}。reject は detail.error、それ以外は文字列。
    const d = data?.detail;
    throw new RegisterError(
      typeof d === 'object' && d?.error
        ? d.error
        : {
            code: 'INTERNAL',
            message: typeof d === 'string' ? d : `登録に失敗しました (HTTP ${res.status})`,
          },
    );
  }
  if (!data?.charId || !data.name) {
    throw new RegisterError({ code: 'INTERNAL', message: '不正な応答' });
  }
  return { charId: data.charId, name: data.name };
}
