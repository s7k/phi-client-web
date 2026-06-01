/**
 * キャラグラ解決([09]§3 フォールバック連鎖)。
 *
 * 解決順:
 *  1. gra_name(=CHRGRA) で specific PNG → /assets/chara/<lower(gra)>.png
 *  2. 無ければ code(default, 末尾type) → webFallbackGra → そのPNG
 *  3. code未一致(or webFallbackGra=null)は intelligent(=t_elf)既定
 *  4. それも解決不能ならプレースホルダ(名前頭文字描画)
 *
 * 物理ファイル名は小文字化済([09]§3.5)。照合は case-insensitive(lowercase)。
 */
import {
  charaTypeByCode,
  charaTypeFallback,
  DEFAULT_TYPE_KEY,
} from '../data/charaTypeFallback';

/** アセット配信ベース。透過PNGは /assets/chara/<lower>.png。 */
const CHARA_ASSET_BASE = '/assets/chara';

/** key → webFallbackGra の索引(既定キー解決用)。 */
const fallbackGraByKey: ReadonlyMap<string, string | null> = new Map(
  charaTypeFallback.map((e) => [e.key, e.webFallbackGra]),
);

/** gra名 → 配信URL(小文字化)。 */
export function graUrl(graName: string): string {
  return `${CHARA_ASSET_BASE}/${graName.toLowerCase()}.png`;
}

/** グラ解決の種別。 */
export type CharaGraKind = 'gra' | 'fallback' | 'placeholder';

export interface ResolvedGra {
  kind: CharaGraKind;
  /** kind!=placeholder の時の配信URL。 */
  url?: string;
  /** 解決に使ったグラ名(小文字化前の原名)。 */
  graName?: string;
  /** placeholder時に描画する頭文字。 */
  initial?: string;
}

/** 名前頭文字(マークアップ除去後)を返す。空なら "?"。 */
function nameInitial(name: string | undefined): string {
  if (!name) return '?';
  // /*...*/ のカラーマークアップを除去。
  const stripped = name.replace(/\/\*.*?\*\//g, '').trim();
  return stripped.slice(0, 1) || '?';
}

/** code → 既定グラ名(webFallbackGra)。未割当/未一致は intelligent 既定。 */
export function fallbackGraForCode(code: number | undefined): string | null {
  if (code != null) {
    const entry = charaTypeByCode.get(code);
    if (entry && entry.webFallbackGra) return entry.webFallbackGra;
  }
  // code未一致 or webFallbackGra=null → intelligent(0x01=t_elf)既定。
  return fallbackGraByKey.get(DEFAULT_TYPE_KEY) ?? null;
}

/**
 * グラ解決。`hasGra(graNameLower)` で specific/fallback PNG の存在を判定。
 * hasGra 省略時は存在チェックせず順に URL を組み立てる(実行時は <img> onerror で連鎖)。
 *
 * @param gra   キャラの gra_name(CHRGRA)。
 * @param code  default(末尾type)。
 * @param name  キャラ名(placeholder頭文字用)。
 * @param hasGra 小文字グラ名→存在可否。テスト/事前マニフェスト判定用。
 */
export function resolveCharaGra(
  gra: string | undefined,
  code: number | undefined,
  name: string | undefined,
  hasGra?: (graLower: string) => boolean,
): ResolvedGra {
  const has = (g: string): boolean => (hasGra ? hasGra(g.toLowerCase()) : true);

  // 1. specific gra
  if (gra && gra.trim() && has(gra)) {
    return { kind: 'gra', url: graUrl(gra), graName: gra };
  }

  // 2/3. code → fallback gra(未一致は intelligent 既定)
  const fb = fallbackGraForCode(code);
  if (fb && has(fb)) {
    return { kind: 'fallback', url: graUrl(fb), graName: fb };
  }

  // 4. placeholder
  return { kind: 'placeholder', initial: nameInitial(name) };
}

/**
 * specific/fallback の解決候補URLを優先順に列挙(存在判定なし)。
 * 実行時に <img> の onerror で順次フォールバックする用途。
 * 末尾は常に intelligent 既定(あれば)。
 */
export function graCandidateUrls(
  gra: string | undefined,
  code: number | undefined,
): string[] {
  const urls: string[] = [];
  const push = (g: string | null | undefined) => {
    if (!g || !g.trim()) return;
    const u = graUrl(g);
    if (!urls.includes(u)) urls.push(u);
  };
  push(gra);
  if (code != null) {
    const entry = charaTypeByCode.get(code);
    push(entry?.webFallbackGra ?? null);
  }
  push(fallbackGraByKey.get(DEFAULT_TYPE_KEY) ?? null);
  return urls;
}
