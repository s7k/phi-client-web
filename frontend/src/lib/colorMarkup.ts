/**
 * Phi サーバの色マークアップ解析。
 * 移植元: phi-client/phi/gui/color_markup.py (TagToHtml.cpp FontTagInterpret 準拠)。
 *
 * 構文:
 *   開き:  /*x*​/            単レター色ショートカット
 *          /*color=NAME*​/   名前付き色 (/*c=NAME*​/, /*cl=NAME*​/ も同義)
 *   閉じ:  /*.*​/            全タグクローズ
 *          /*attr=.*​/       当該属性の最内タグを1つクローズ
 *   画像:  /*img=URL*​/       インライン画像(F11, [05]§13)。http/https のみ許可・サニタイズ。
 *
 * 未対応タグ(size=,font=,style=)は黙って除去。
 * 戻り値: セグメント配列。text セグメント({text,color}) または image セグメント({img})。
 */

/** 単レター色ショートカット(Log.css .color_x_ 由来)。 */
const LETTER_COLORS: Record<string, string> = {
  a: '#0097A7', // aqua
  b: '#1976D2', // blue
  c: '#0097A7', // cyan
  f: '#C2185B', // fuchsia
  g: '#388E3C', // green
  h: '#616161', // gray
  k: '#212121', // black
  l: '#689F38', // lime
  m: '#C62828', // maroon
  n: '#283593', // navy
  o: '#E65100', // olive
  p: '#7B1FA2', // purple
  r: '#D32F2F', // red
  s: '#546E7A', // silver
  t: '#00838F', // teal
  w: '#9FA8DA', // white(明背景で視認可)
  y: '#F9A825', // yellow
};

/** 特殊名(Log.css .color__hp 等)。 */
const SPECIAL: Record<string, string> = {
  '+hp': '#388E3C',
  '-hp': '#D32F2F',
  '+mp': '#1976D2',
  '-mp': '#D32F2F',
  '#777': '#616161',
  white: '#9FA8DA',
  cyan: '#0097A7',
  yellow: '#F9A825',
};

/** CSS色キーワード → Material 等価色。 */
const CSS_COLORS: Record<string, string> = {
  aqua: '#0097A7',
  blue: '#1976D2',
  cyan: '#0097A7',
  fuchsia: '#C2185B',
  green: '#388E3C',
  gray: '#616161',
  grey: '#616161',
  lime: '#689F38',
  magenta: '#C2185B',
  maroon: '#C62828',
  navy: '#283593',
  olive: '#E65100',
  orange: '#E65100',
  purple: '#7B1FA2',
  red: '#D32F2F',
  silver: '#546E7A',
  teal: '#00838F',
  white: '#9FA8DA',
  yellow: '#F9A825',
  black: '#212121',
};

// TagToHtml.cpp のパターンに対応。
// group1=inner(全体), group2=attr(color/cl/c/size/font/ft/style/img), group3=value。
const TAG_RE =
  /\/\*(\.|[a-zA-Z]|(color|cl|c|size|font|ft|style|img)=(.+?))\*\//gi;
const COLOR_ATTR_RE = /^(?:color|cl|c)$/i;
const HEX3 = /^#[0-9a-fA-F]{3}$/;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** 色名/hex → hex文字列。未知は null。 */
function resolve(name: string): string | null {
  const s = name.trim();
  const lower = s.toLowerCase();
  if (lower in SPECIAL) return SPECIAL[lower];
  if (lower in CSS_COLORS) return CSS_COLORS[lower];
  if (HEX3.test(s) || HEX6.test(s)) return s;
  return null;
}

/** テキスト装飾セグメント。color は hex か null(既定前景色)。 */
export interface TextSegment {
  kind: 'text';
  text: string;
  color: string | null;
}

/** 画像セグメント(img= タグ)。url はサニタイズ済(http/https のみ)。 */
export interface ImageSegment {
  kind: 'image';
  url: string;
}

export type MarkupSegment = TextSegment | ImageSegment;

/**
 * img= の URL をサニタイズ([05]§13)。
 * - http/https スキームのみ許可(javascript:/data: 等を拒否)。
 * - 空白・引用符・山括弧を除去(属性インジェクション防止。CSP前提)。
 * - 不正は null。
 */
export function sanitizeImageUrl(raw: string): string | null {
  const s = raw.trim();
  // 制御文字・空白・属性破壊文字を含む場合は拒否(URLとして不正)。
  if (/[\s"'<>`\\]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.href;
}

/**
 * Phi 色マークアップを解析しセグメント配列を返す。
 * stack: 開いた色(null=既定 push でカウント均衡)。
 */
export function parseMarkup(text: string): MarkupSegment[] {
  // 空タグ `/**/`(DM側の荒らし対策で名前前等に付く no-op マーカー。
  // 先頭`*`の大声化回避エスケープ由来)は不可視にする([05]§1, A-14)。
  text = text.replace(/\/\*\*\//g, '');

  const segments: MarkupSegment[] = [];
  const stack: (string | null)[] = [];
  let pos = 0;

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    const before = text.slice(pos, m.index);
    if (before) {
      segments.push({ kind: 'text', text: before, color: stack.length ? stack[stack.length - 1] : null });
    }
    pos = TAG_RE.lastIndex;

    const inner = m[1]; // /* と */ の間の全内容
    const attr = m[2] as string | undefined; // color/c/size/img/...
    const value = m[3] as string | undefined; // '=' 以降

    if (inner === '.') {
      // /*.*​/ — 全タグクローズ
      stack.length = 0;
    } else if (attr !== undefined) {
      if (/^img$/i.test(attr)) {
        // /*img=URL*​/ — インライン画像([05]§13)。サニタイズ通過時のみ。
        const url = sanitizeImageUrl(value ?? '');
        if (url) segments.push({ kind: 'image', url });
      } else if (value === '.') {
        // /*attr=.*​/ — 1タグクローズ
        if (stack.length) stack.pop();
      } else if (COLOR_ATTR_RE.test(attr)) {
        // /*color=NAME*​/ 等
        stack.push(resolve(value ?? '')); // 未知は null をプレースホルダで push
      }
      // size=/font=/style= は無視(push しない)
    } else if (inner.length === 1) {
      // /*x*​/ — 単レター色
      stack.push(LETTER_COLORS[inner.toLowerCase()] ?? null);
    }
  }

  const tail = text.slice(pos);
  if (tail) {
    segments.push({ kind: 'text', text: tail, color: stack.length ? stack[stack.length - 1] : null });
  }

  return segments;
}
