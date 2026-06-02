import { describe, it, expect } from 'vitest';
import { resolveKey, type KeyContext } from '../src/lib/keyHandler';

/** KeyboardEvent 風の最小オブジェクト生成。 */
function key(
  k: string,
  opts: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key: k,
    code: opts.code ?? '',
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    // numpad 判定用
    location: opts.location ?? 0,
  } as unknown as KeyboardEvent;
}

const baseCtx = (over: Partial<KeyContext> = {}): KeyContext => ({
  layout: 'wasd',
  northFix: false,
  listActive: false,
  inputFocused: false,
  magic: {},
  shortcuts: {},
  ...over,
});

describe('resolveKey: Shift+G(altG) ショートカット', () => {
  it('altG 設定あり + Shift+G で raw コマンド送出', () => {
    expect(resolveKey(key('G', { shiftKey: true }), baseCtx({ altG: 'guild' }))).toEqual({
      type: 'command', name: 'raw', text: 'guild',
    });
  });
  it('altG 空なら無修飾扱い(g=equip on wasd, Shift無視)', () => {
    // altG 未設定時は Shift+G は altG 分岐に入らず、通常の g 解決へ流れる。
    expect(resolveKey(key('G', { shiftKey: true }), baseCtx({ layout: 'wasd', altG: '' }))).toEqual({
      type: 'command', name: 'equip',
    });
  });
  it('Shift なしの g は altG を発火しない(g=equip)', () => {
    expect(resolveKey(key('g'), baseCtx({ layout: 'wasd', altG: 'guild' }))).toEqual({
      type: 'command', name: 'equip',
    });
  });
});

describe('resolveKey: 入力欄フォーカス時はゲームキー無効', () => {
  it('inputFocused なら null', () => {
    expect(resolveKey(key('w'), baseCtx({ inputFocused: true }))).toBeNull();
    // Fnキーも無効(入力中の誤爆防止)
    expect(resolveKey(key('F1'), baseCtx({ inputFocused: true }))).toBeNull();
  });
});

describe('resolveKey: 移動 wasd レイアウト (turnモード)', () => {
  const ctx = baseCtx({ layout: 'wasd', northFix: false });
  it('W=前進(step F)', () => {
    expect(resolveKey(key('w'), ctx)).toEqual({
      type: 'move',
      mode: 'step',
      dir: 'F',
    });
  });
  it('S=後退(step B)', () => {
    expect(resolveKey(key('s'), ctx)).toEqual({
      type: 'move',
      mode: 'step',
      dir: 'B',
    });
  });
  it('A=左ストレイフ(strafe L)', () => {
    expect(resolveKey(key('a'), ctx)).toEqual({
      type: 'move',
      mode: 'strafe',
      dir: 'L',
    });
  });
  it('D=右ストレイフ(strafe R)', () => {
    expect(resolveKey(key('d'), ctx)).toEqual({
      type: 'move',
      mode: 'strafe',
      dir: 'R',
    });
  });
  it('Q=左回転(turn l)', () => {
    expect(resolveKey(key('q'), ctx)).toEqual({
      type: 'move',
      mode: 'turn',
      dir: 'l',
    });
  });
  it('E=右回転(turn r)', () => {
    expect(resolveKey(key('e'), ctx)).toEqual({
      type: 'move',
      mode: 'turn',
      dir: 'r',
    });
  });
  it('X=Uターン(turn b)', () => {
    expect(resolveKey(key('x'), ctx)).toEqual({
      type: 'move',
      mode: 'turn',
      dir: 'b',
    });
  });
});

describe('resolveKey: 移動 numpad レイアウト', () => {
  const ctx = baseCtx({ layout: 'numpad', northFix: false });
  it('numpad レイアウトの文字キー I=Uターン(turn b)', () => {
    expect(resolveKey(key('i'), ctx)).toEqual({
      type: 'move',
      mode: 'turn',
      dir: 'b',
    });
  });
  it('wasd の W は numpad レイアウトでは移動でない(コマンド unequip)', () => {
    // numpad layout で W は KeyBindNone="unequip"(既知CommandName)
    expect(resolveKey(key('w'), ctx)).toEqual({
      type: 'command',
      name: 'unequip',
    });
  });
});

describe('resolveKey: テンキー・カーソルは常時有効', () => {
  const ctx = baseCtx({ layout: 'wasd', northFix: false });
  it('テンキー8=前進(location=3)', () => {
    expect(
      resolveKey(key('8', { location: 3 }), ctx),
    ).toEqual({ type: 'move', mode: 'step', dir: 'F' });
  });
  it('テンキー7=左回転', () => {
    expect(resolveKey(key('7', { location: 3 }), ctx)).toEqual({
      type: 'move',
      mode: 'turn',
      dir: 'l',
    });
  });
  it('カーソル上=前進', () => {
    expect(resolveKey(key('ArrowUp'), ctx)).toEqual({
      type: 'move',
      mode: 'step',
      dir: 'F',
    });
  });
  it('カーソル左=左回転(turnモード既定)', () => {
    expect(resolveKey(key('ArrowLeft'), ctx)).toEqual({
      type: 'move',
      mode: 'turn',
      dir: 'l',
    });
  });
});

describe('resolveKey: north-fix モードの移動(絶対方位)', () => {
  const ctx = baseCtx({ layout: 'wasd', northFix: true });
  it('W=go N(絶対北)', () => {
    expect(resolveKey(key('w'), ctx)).toEqual({
      type: 'move',
      mode: 'step',
      dir: 'N',
    });
  });
  it('A=go W', () => {
    expect(resolveKey(key('a'), ctx)).toEqual({
      type: 'move',
      mode: 'step',
      dir: 'W',
    });
  });
  it('カーソル左=go W(north-fixでは移動)', () => {
    expect(resolveKey(key('ArrowLeft'), ctx)).toEqual({
      type: 'move',
      mode: 'step',
      dir: 'W',
    });
  });
  it('Q=左回転(north-fixでも回転)', () => {
    expect(resolveKey(key('q'), ctx)).toEqual({
      type: 'move',
      mode: 'turn',
      dir: 'l',
    });
  });
});

describe('resolveKey: リストモード分岐', () => {
  const ctx = baseCtx({ listActive: true });
  it('数字1-9 → list.select(value数値)', () => {
    expect(resolveKey(key('3'), ctx)).toEqual({
      type: 'list.select',
      value: 3,
    });
  });
  it('0 → cancel', () => {
    expect(resolveKey(key('0'), ctx)).toEqual({
      type: 'list.select',
      value: 'cancel',
    });
  });
  it('Esc → cancel', () => {
    expect(resolveKey(key('Escape'), ctx)).toEqual({
      type: 'list.select',
      value: 'cancel',
    });
  });
  it('+ → all', () => {
    expect(resolveKey(key('+'), ctx)).toEqual({
      type: 'list.select',
      value: 'all',
    });
  });
  it('リスト中は移動キー(w)を消費しない=null', () => {
    expect(resolveKey(key('w'), ctx)).toBeNull();
  });
});

describe('resolveKey: ファンクションキー magic/shortcut', () => {
  it('F1 が magic 割当済 → castMagic', () => {
    const ctx = baseCtx({ magic: { F1: 'heal' } });
    expect(resolveKey(key('F1'), ctx)).toEqual({
      type: 'command',
      name: 'castMagic',
      spell: 'heal',
    });
  });
  it('F3 未割当 → null', () => {
    const ctx = baseCtx({ magic: { F1: 'heal' } });
    expect(resolveKey(key('F3'), ctx)).toBeNull();
  });
  it('F8 が shortcut 割当済 → raw command', () => {
    const ctx = baseCtx({ shortcuts: { F8: 'spells' } });
    expect(resolveKey(key('F8'), ctx)).toEqual({
      type: 'command',
      name: 'raw',
      text: 'spells',
    });
  });
  it('F12 未割当 → null', () => {
    expect(resolveKey(key('F12'), baseCtx())).toBeNull();
  });
});

describe('resolveKey: アクションキー', () => {
  it('wasd: B=board', () => {
    expect(resolveKey(key('b'), baseCtx({ layout: 'wasd' }))).toEqual({
      type: 'command',
      name: 'board',
    });
  });
  it('wasd: Z=get', () => {
    expect(resolveKey(key('z'), baseCtx({ layout: 'wasd' }))).toEqual({
      type: 'command',
      name: 'get',
    });
  });
  it('Ctrl+key(攻撃)=hit (Space)', () => {
    expect(resolveKey(key(' '), baseCtx())).toEqual({
      type: 'command',
      name: 'hit',
    });
  });
  it('未割当キー → null', () => {
    expect(resolveKey(key('`'), baseCtx())).toBeNull();
  });
});
