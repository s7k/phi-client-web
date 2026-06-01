/**
 * キャラタイプコード → フォールバックグラ マッピング。
 * 出典: backend/data/chara_type_fallback.json(編集不可)から値をコピーしバンドル([09])。
 * code = #m57 O 末尾フィールド(map.chars[].default)。
 * webFallbackGra = フォールバックグラ名(拡張子なし、case-insensitiveで照合)。
 */

export interface CharaTypeEntry {
  /** タイプコード(0-255)。 */
  code: number;
  /** Web用カテゴリキー。 */
  key: string;
  /** カテゴリ名(日本語)。 */
  ja: string;
  /** フォールバックグラ名(拡張子なし)。未割当は null。 */
  webFallbackGra: string | null;
}

/** code → エントリ。JSONの types からコピー。 */
export const charaTypeFallback: readonly CharaTypeEntry[] = [
  { code: 0, key: 'human', ja: '人・銅像', webFallbackGra: 't_Man' },
  { code: 1, key: 'intelligent', ja: '知的生物', webFallbackGra: 't_elf' },
  { code: 2, key: 'beast', ja: '獣', webFallbackGra: 't_dog' },
  { code: 3, key: 'berserk', ja: '狂戦士', webFallbackGra: 't_fightery' },
  { code: 4, key: 'magical', ja: '魔法生物', webFallbackGra: null },
  { code: 5, key: 'undead', ja: 'アンデッド', webFallbackGra: 't_ghost1' },
  { code: 6, key: 'astral', ja: '精神体', webFallbackGra: null },
  { code: 7, key: 'eraser', ja: 'イレイザー', webFallbackGra: 'tak_Bslime' },
  { code: 64, key: 'setcg', ja: 'setcg使用キャラ', webFallbackGra: null },
  { code: 128, key: 'creature', ja: '生物', webFallbackGra: null },
  { code: 129, key: 'board', ja: '看板', webFallbackGra: null },
  { code: 130, key: 'magic_effect', ja: '魔法エフェクト', webFallbackGra: null },
  { code: 112, key: 'anim_object', ja: 'アニメオブジェ', webFallbackGra: null },
  { code: 117, key: 'static_object', ja: 'アニメなしオブジェ', webFallbackGra: null },
] as const;

/** 既定カテゴリ(type未一致時の fallback, [09]§3手順3)。intelligent=0x01=t_elf。 */
export const DEFAULT_TYPE_KEY = 'intelligent';

/** code → エントリの索引。 */
export const charaTypeByCode: ReadonlyMap<number, CharaTypeEntry> = new Map(
  charaTypeFallback.map((e) => [e.code, e]),
);
