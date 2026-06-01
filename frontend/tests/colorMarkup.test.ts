import { describe, it, expect } from 'vitest';
import { parseMarkup, sanitizeImageUrl } from '../src/lib/colorMarkup';

/** 先頭 text セグメントの色(image なら例外)。 */
function firstColor(s: string): string | null {
  const seg = parseMarkup(s)[0];
  if (seg.kind !== 'text') throw new Error('text セグメントではない');
  return seg.color;
}

describe('parseMarkup', () => {
  it('マークアップ無しは単一セグメント(色なし)', () => {
    expect(parseMarkup('hello')).toEqual([{ kind: 'text', text: 'hello', color: null }]);
  });

  it('単レター色 /r/ → text → /.​/ で閉じる', () => {
    const segs = parseMarkup('a/*r*/red/*.*/b');
    expect(segs).toEqual([
      { kind: 'text', text: 'a', color: null },
      { kind: 'text', text: 'red', color: '#D32F2F' },
      { kind: 'text', text: 'b', color: null },
    ]);
  });

  it('color=NAME と c=/cl= 同義', () => {
    expect(parseMarkup('/*color=blue*/x')[0]).toEqual({
      kind: 'text',
      text: 'x',
      color: '#1976D2',
    });
    expect(firstColor('/*c=blue*/x')).toBe('#1976D2');
    expect(firstColor('/*cl=blue*/x')).toBe('#1976D2');
  });

  it('hex値はそのまま採用', () => {
    expect(firstColor('/*color=#abc*/x')).toBe('#abc');
    expect(firstColor('/*color=#A1B2C3*/x')).toBe('#A1B2C3');
  });

  it('未知色は null(プレースホルダ push でカウント均衡)', () => {
    const segs = parseMarkup('/*color=zzz*/x/*.*/y');
    expect(segs[0]).toEqual({ kind: 'text', text: 'x', color: null });
    expect(segs[1]).toEqual({ kind: 'text', text: 'y', color: null });
  });

  it('ネストと /attr=.​/ 1段クローズ', () => {
    // green 開→ blue 開→ "in"(blue) → color=. で blue 閉→ "out"(green)
    const segs = parseMarkup('/*g*/a/*b*/in/*color=.*/out');
    expect(segs).toEqual([
      { kind: 'text', text: 'a', color: '#388E3C' },
      { kind: 'text', text: 'in', color: '#1976D2' },
      { kind: 'text', text: 'out', color: '#388E3C' },
    ]);
  });

  it('size=/font=/style= は無視(push しない)', () => {
    const segs = parseMarkup('/*r*//*size=20*/x/*.*/');
    expect(segs).toEqual([{ kind: 'text', text: 'x', color: '#D32F2F' }]);
  });

  it('特殊名 +hp/-hp', () => {
    expect(firstColor('/*color=+hp*/x')).toBe('#388E3C');
    expect(firstColor('/*color=-hp*/x')).toBe('#D32F2F');
  });

  it('空文字', () => {
    expect(parseMarkup('')).toEqual([]);
  });
});

describe('sanitizeImageUrl', () => {
  it('http/https は許可', () => {
    expect(sanitizeImageUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
    expect(sanitizeImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('javascript:/data: スキームは拒否', () => {
    expect(sanitizeImageUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeImageUrl('data:image/png;base64,AAAA')).toBeNull();
  });

  it('属性破壊文字(空白/引用符/山括弧)を含むと拒否', () => {
    expect(sanitizeImageUrl('http://x/a.png" onerror="alert(1)')).toBeNull();
    expect(sanitizeImageUrl('http://x/<svg>')).toBeNull();
  });

  it('URLとして不正なら拒否', () => {
    expect(sanitizeImageUrl('not a url')).toBeNull();
    expect(sanitizeImageUrl('/relative/path.png')).toBeNull();
  });
});

describe('parseMarkup img= タグ', () => {
  it('img= を image セグメント化(サニタイズ通過)', () => {
    const segs = parseMarkup('前/*img=https://e.com/a.png*/後');
    expect(segs).toEqual([
      { kind: 'text', text: '前', color: null },
      { kind: 'image', url: 'https://e.com/a.png' },
      { kind: 'text', text: '後', color: null },
    ]);
  });

  it('不正 img= はセグメント化せず除去', () => {
    const segs = parseMarkup('x/*img=javascript:alert(1)*/y');
    expect(segs).toEqual([
      { kind: 'text', text: 'x', color: null },
      { kind: 'text', text: 'y', color: null },
    ]);
  });
});
