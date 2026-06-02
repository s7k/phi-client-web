/**
 * キャラクター REST クライアント(A-34)。
 *
 * アカウント配下の複数キャラ(ラベル+PHI ID+IP+ポート)を CRUD する。
 * 全 API は Authorization: Bearer <token>(localStorage)を付与。
 * PHI uid(charId が参照する PHI ID)は BE 非公開: 一覧応答に含まれず FE は charId で参照。
 *
 * - GET    /api/characters → {characters:[{charId,label,host,port}]}。
 * - POST   /api/characters {label, phiId, host, port} → 追加。
 * - DELETE /api/characters/{charId} → 削除。
 *
 * 注: phiId / token は資格情報。ここでログ出力しない。
 */
import { getStoredToken } from './auth';

/** 一覧で返るキャラ1件。uid(PHI ID)は非公開で charId で参照。 */
export interface Character {
  charId: string;
  label: string;
  host: string;
  port: number;
}

/** POST /api/characters の入力(既存キャラの登録)。 */
export interface CreateCharacterBody {
  label: string;
  /** PHI ID(生)。BE 保管、FE は以後保持しない。 */
  phiId: string;
  host: string;
  port: number;
}

/** REST 失敗を表す例外。 */
export class CharacterError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'BAD_REQUEST', status = 0) {
    super(message);
    this.name = 'CharacterError';
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

/** Bearer ヘッダ(token あれば付与)。 */
function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = getStoredToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

async function readError(res: Response): Promise<CharacterError> {
  const data = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | null;
  return new CharacterError(
    data?.error?.message ?? `要求に失敗しました (HTTP ${res.status})`,
    data?.error?.code ?? 'BAD_REQUEST',
    res.status,
  );
}

/** キャラ一覧取得(GET /api/characters, Bearer)。 */
export async function listCharacters(fetchImpl?: FetchLike): Promise<Character[]> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/characters', {
    method: 'GET',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json().catch(() => null)) as
    | { characters?: Character[] }
    | Character[]
    | null;
  if (Array.isArray(data)) return data;
  return data?.characters ?? [];
}

/** キャラ追加(POST /api/characters, Bearer)。成功で追加後の1件を返す(BE応答依存)。 */
export async function createCharacter(
  body: CreateCharacterBody,
  fetchImpl?: FetchLike,
): Promise<Character | null> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/characters', {
    method: 'POST',
    headers: authHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json().catch(() => null)) as
    | (Character & { ok?: boolean })
    | { ok?: boolean }
    | null;
  if (data && 'charId' in data) return data as Character;
  return null;
}

/** キャラ削除(DELETE /api/characters/{charId}, Bearer)。 */
export async function deleteCharacter(
  charId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const f = resolveFetch(fetchImpl);
  const res = await f(`/api/characters/${encodeURIComponent(charId)}`, {
    method: 'DELETE',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw await readError(res);
}
