/**
 * Phi サーバの色マークアップ解析。
 * 移植元: phi-client/phi/gui/color_markup.py (TagToHtml.cpp FontTagInterpret 準拠)。
 *
 * 構文:
 *   開き:  /*x*​/            単レター色ショートカット
 *          /*color=NAME*​/   名前付き色 (/*c=NAME*​/, /*cl=NAME*​/ も同義)
 *   閉じ:  /*.*​/            全タグクローズ
 *          /*attr=.*​/       当該属性の最内タグを1つクローズ
 *
 * 未対応タグ(size=,font=,style=,img=)は黙って除去。
 * 戻り値: { text, color } セグメント配列。color は CSS hex か null(既定前景色)。
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
// group1=inner(全体), group2=attr(color/cl/c/size/font/ft/style), group3=value。
const TAG_RE =
  /\/\*(\.|[a-zA-Z]|(color|cl|c|size|font|ft|style)=(.+?))\*\//gi;
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

/** 装飾セグメント。color は hex か null(既定前景色)。 */
export interface MarkupSegment {
  text: string;
  color: string | null;
}

/**
 * Phi 色マークアップを解析しセグメント配列を返す。
 * stack: 開いた色(null=既定 push でカウント均衡)。
 */
export function parseMarkup(text: string): MarkupSegment[] {
  const segments: MarkupSegment[] = [];
  const stack: (string | null)[] = [];
  let pos = 0;

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    const before = text.slice(pos, m.index);
    if (before) {
      segments.push({ text: before, color: stack.length ? stack[stack.length - 1] : null });
    }
    pos = TAG_RE.lastIndex;

    const inner = m[1]; // /* と */ の間の全内容
    const attr = m[2] as string | undefined; // color/c/size/...
    const value = m[3] as string | undefined; // '=' 以降

    if (inner === '.') {
      // /*.*​/ — 全タグクローズ
      stack.length = 0;
    } else if (attr !== undefined) {
      if (value === '.') {
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
    segments.push({ text: tail, color: stack.length ? stack[stack.length - 1] : null });
  }

  return segments;
}
