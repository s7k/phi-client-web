/**
 * アセット管理 REST クライアント(管理画面)。
 *
 * キャラグラ(/api/chara)・マップチップ(/api/chip)・Index エイリアス
 * (/api/chara/index)の一覧/アップロード/削除/編集。変更系は Bearer 必須
 * (BE 側 require_admin で管理者限定。GET は誰でも可)。
 *
 * - キャラグラ: 96x160、同名/不正寸法は BE が 400/409。
 * - マップチップ: 入力 1024x96(左右分割)→ 512x96 変換。
 * - protected(=リポジトリ同梱 seed)は削除不可(403)。
 */
import { getStoredToken } from './auth';

export interface GraphicMeta {
  graName: string;
  url: string;
  width: number;
  height: number;
  colorKey: string;
  protected: boolean;
  uploadedAt: string;
}

export interface ChipMeta {
  mapset: string;
  url: string;
  width: number;
  height: number;
  protected: boolean;
  uploadedAt: string;
}

export interface IndexEntry {
  key: string;
  graName: string;
}

export class AssetError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'BAD_REQUEST', status = 0) {
    super(message);
    this.name = 'AssetError';
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

async function readError(res: Response): Promise<AssetError> {
  // FastAPI のエラーは {detail} 形式。共通 readError で message を拾う。
  const data = (await res.json().catch(() => null)) as
    | { detail?: string; error?: { code?: string; message?: string } }
    | null;
  const msg =
    data?.error?.message ?? data?.detail ?? `要求に失敗しました (HTTP ${res.status})`;
  return new AssetError(msg, data?.error?.code ?? 'BAD_REQUEST', res.status);
}

// ── キャラグラ ───────────────────────────────────────────────

export async function listGraphics(fetchImpl?: FetchLike): Promise<GraphicMeta[]> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/chara/graphics', { headers: authHeaders({ Accept: 'application/json' }) });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as GraphicMeta[];
}

export async function uploadGraphic(
  file: File,
  graName: string,
  colorKey = 'teal',
  fetchImpl?: FetchLike,
): Promise<GraphicMeta> {
  const f = resolveFetch(fetchImpl);
  const fd = new FormData();
  fd.append('file', file);
  fd.append('graName', graName);
  fd.append('colorKey', colorKey);
  const res = await f('/api/chara/graphics', {
    method: 'POST',
    headers: authHeaders({ Accept: 'application/json' }),
    body: fd,
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as GraphicMeta;
}

export async function deleteGraphic(graName: string, fetchImpl?: FetchLike): Promise<void> {
  const f = resolveFetch(fetchImpl);
  const res = await f(`/api/chara/graphics/${encodeURIComponent(graName)}`, {
    method: 'DELETE',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw await readError(res);
}

// ── マップチップ ─────────────────────────────────────────────

export async function listChips(fetchImpl?: FetchLike): Promise<ChipMeta[]> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/chip/graphics', { headers: authHeaders({ Accept: 'application/json' }) });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ChipMeta[];
}

export async function uploadChip(
  file: File,
  mapset: string,
  fetchImpl?: FetchLike,
): Promise<ChipMeta> {
  const f = resolveFetch(fetchImpl);
  const fd = new FormData();
  fd.append('file', file);
  fd.append('mapset', mapset);
  const res = await f('/api/chip/graphics', {
    method: 'POST',
    headers: authHeaders({ Accept: 'application/json' }),
    body: fd,
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ChipMeta;
}

export async function deleteChip(mapset: string, fetchImpl?: FetchLike): Promise<void> {
  const f = resolveFetch(fetchImpl);
  const res = await f(`/api/chip/graphics/${encodeURIComponent(mapset)}`, {
    method: 'DELETE',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw await readError(res);
}

// ── Index エイリアス(キャラ名 ↔ グラ名) ──────────────────────

export async function listIndex(fetchImpl?: FetchLike): Promise<IndexEntry[]> {
  const f = resolveFetch(fetchImpl);
  const res = await f('/api/chara/index', { headers: authHeaders({ Accept: 'application/json' }) });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as IndexEntry[];
}

export async function putIndex(
  key: string,
  graName: string,
  fetchImpl?: FetchLike,
): Promise<IndexEntry> {
  const f = resolveFetch(fetchImpl);
  const res = await f(`/api/chara/index/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ graName }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as IndexEntry;
}

export async function deleteIndex(key: string, fetchImpl?: FetchLike): Promise<void> {
  const f = resolveFetch(fetchImpl);
  const res = await f(`/api/chara/index/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: authHeaders({ Accept: 'application/json' }),
  });
  if (!res.ok) throw await readError(res);
}
