/**
 * WS 接続先 URL の解決。
 *
 * 既定は相対 `/ws`(同一オリジン → vite dev proxy / 本番リバースプロキシ経由で BE へ)。
 * env `VITE_WS_URL` で上書き可。値の形式:
 *  - 絶対(`ws://` / `wss://`): そのまま使用。
 *  - 相対(先頭 `/`): 現オリジンの protocol/host で絶対化(http→ws, https→wss)。
 *  - `//host/path`(scheme相対): 現 protocol に合わせ ws/wss を付与。
 */
export interface OriginLike {
  protocol: string; // 'http:' | 'https:'
  host: string; // 'localhost:5173'
}

export function resolveWsUrl(
  raw: string | undefined,
  origin: OriginLike = location,
): string {
  const value = raw && raw.trim() !== '' ? raw.trim() : '/ws';

  // 絶対 WS URL はそのまま。
  if (/^wss?:\/\//i.test(value)) return value;

  const wsScheme = origin.protocol === 'https:' ? 'wss' : 'ws';

  // scheme 相対(//host/path)。
  if (value.startsWith('//')) return `${wsScheme}:${value}`;

  // 相対パス(先頭 / を保証)。
  const path = value.startsWith('/') ? value : `/${value}`;
  return `${wsScheme}://${origin.host}${path}`;
}
