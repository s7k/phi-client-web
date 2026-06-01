import { describe, it, expect } from 'vitest';
import { parseMarkup } from '../src/lib/colorMarkup';

describe('parseMarkup', () => {
  it('マークアップ無しは単一セグメント(色なし)', () => {
    expect(parseMarkup('hello')).toEqual([{ text: 'hello', color: null }]);
  });

  it('単レター色 /r/ → text → /.​/ で閉じる', () => {
    const segs = parseMarkup('a/*r*/red/*.*/b');
    expect(segs).toEqual([
      { text: 'a', color: null },
      { text: 'red', color: '#D32F2F' },
      { text: 'b', color: null },
    ]);
  });

  it('color=NAME と c=/cl= 同義', () => {
    expect(parseMarkup('/*color=blue*/x')[0]).toEqual({
      text: 'x',
      color: '#1976D2',
    });
    expect(parseMarkup('/*c=blue*/x')[0].color).toBe('#1976D2');
    expect(parseMarkup('/*cl=blue*/x')[0].color).toBe('#1976D2');
  });

  it('hex値はそのまま採用', () => {
    expect(parseMarkup('/*color=#abc*/x')[0].color).toBe('#abc');
    expect(parseMarkup('/*color=#A1B2C3*/x')[0].color).toBe('#A1B2C3');
  });

  it('未知色は null(プレースホルダ push でカウント均衡)', () => {
    const segs = parseMarkup('/*color=zzz*/x/*.*/y');
    expect(segs[0]).toEqual({ text: 'x', color: null });
    expect(segs[1]).toEqual({ text: 'y', color: null });
  });

  it('ネストと /attr=.​/ 1段クローズ', () => {
    // green 開→ blue 開→ "in"(blue) → color=. で blue 閉→ "out"(green)
    const segs = parseMarkup('/*g*/a/*b*/in/*color=.*/out');
    expect(segs).toEqual([
      { text: 'a', color: '#388E3C' },
      { text: 'in', color: '#1976D2' },
      { text: 'out', color: '#388E3C' },
    ]);
  });

  it('size=/font=/style= は無視(push しない)', () => {
    const segs = parseMarkup('/*r*//*size=20*/x/*.*/');
    expect(segs).toEqual([{ text: 'x', color: '#D32F2F' }]);
  });

  it('特殊名 +hp/-hp', () => {
    expect(parseMarkup('/*color=+hp*/x')[0].color).toBe('#388E3C');
    expect(parseMarkup('/*color=-hp*/x')[0].color).toBe('#D32F2F');
  });

  it('空文字', () => {
    expect(parseMarkup('')).toEqual([]);
  });
});
