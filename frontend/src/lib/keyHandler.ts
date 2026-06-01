/**
 * F8 キーハンドラ — キー入力を intent へ解決する純関数([12]§3.1, [05]§6)。
 *
 * 鉄則([05]): FEはレガシー文字列を組み立てない。意図(intent)のみ返し、
 * BEが go/turn/cast 等へ整形する。本モジュールは「どのキーで何の意図か」のみ担う。
 *
 * 移植元: phi-client `phi/gui/key_handler.py`(キー→コマンド対応表)。
 * 移動のレガシー文字列化(go N / turn l / go fl 等)はBE責務のため、
 * FEは move intent を {mode, dir} の抽象で送り、BEがmap.dir(A-06)で解決する。
 *
 * - 移動: レイアウト(wasd/numpad)に応じ前後左右/回転を解決。カーソル/テンキーは常時有効。
 *   - turnモード(northFix=false): 前=step F / 後=step B / 左右=strafe L/R / 回転=turn l/r/b
 *   - 北固定(northFix=true): 絶対 step N/E/S/W、回転は turn l/r/b
 * - リストモード中(listActive): 数字1-9→list.select(value数値), 0/Esc→cancel, +→all。
 * - F1-F7=magic(keybind.magic→castMagic), F8-F12=shortcuts(raw command)。
 * - 入力欄フォーカス時(inputFocused)はゲームキー無効化。
 */
import type { CommandSimpleRequest } from '../types/protocol';

/** キーハンドラが直接発行する無パラメータコマンド名(CommandSimpleRequest 由来)。 */
export type SimpleCommandName = CommandSimpleRequest['name'];

/** 移動レイアウト([12]§3.1)。 */
export type KeyLayout = 'wasd' | 'numpad';

/** キー解決に必要な文脈。 */
export interface KeyContext {
  layout: KeyLayout;
  /** 北固定(7x7 solid)か。false=turnモード。settings.display.mapStyle 由来。 */
  northFix: boolean;
  /** リストモード中(modeStore.list)か。 */
  listActive: boolean;
  /** チャット/編集など入力欄にフォーカスがあるか。 */
  inputFocused: boolean;
  /** F1-F7 → 呪文名(keybind.magic)。 */
  magic: Partial<Record<string, string | null>>;
  /** F8-F12 → コマンド語(keybind.shortcuts)。 */
  shortcuts: Partial<Record<string, string | null>>;
}

/** 回転方向(レガシー turn l/r/b)。 */
export type TurnDir = 'l' | 'r' | 'b';

/** keyHandler が返す intent。 */
export type KeyIntent =
  | { type: 'move'; mode: 'step' | 'strafe'; dir: 'F' | 'B' | 'L' | 'R' | 'N' | 'E' | 'S' | 'W' }
  | { type: 'move'; mode: 'turn'; dir: TurnDir }
  | { type: 'list.select'; value: number | 'all' | 'cancel' }
  | { type: 'command'; name: SimpleCommandName }
  | { type: 'command'; name: 'castMagic'; spell: string }
  | { type: 'command'; name: 'raw'; text: string };

// ----------------------------------------------------------------------------
// 移動アクションの抽象表現(レイアウト非依存)
// ----------------------------------------------------------------------------

/** 抽象移動アクション。実際のintentは northFix で分岐して生成。 */
type MoveAction =
  | 'forward'
  | 'back'
  | 'strafeL'
  | 'strafeR'
  | 'turnL'
  | 'turnR'
  | 'turnB'
  // 北固定時のみ意味を持つ絶対方位(カーソルキー用の既定)
  | 'absN'
  | 'absS'
  | 'absW'
  | 'absE';

/** wasd レイアウト: 文字キー → 移動アクション。 */
const WASD_MOVE: Record<string, MoveAction> = {
  w: 'forward',
  s: 'back',
  a: 'strafeL',
  d: 'strafeR',
  q: 'turnL',
  e: 'turnR',
  x: 'turnB',
};

/** numpad レイアウト: 文字キー(仮想テンキー 7/8/9/U/I/O/K) → 移動アクション。 */
const NUMPAD_LETTER_MOVE: Record<string, MoveAction> = {
  '7': 'turnL',
  '8': 'forward',
  '9': 'turnR',
  u: 'strafeL',
  i: 'turnB',
  o: 'strafeR',
  k: 'back',
};

/** 物理テンキー(location=3): 数字 → 移動アクション。常時有効。 */
const NUMPAD_KEY_MOVE: Record<string, MoveAction> = {
  '2': 'back',
  '4': 'strafeL',
  '5': 'turnB',
  '6': 'strafeR',
  '7': 'turnL',
  '8': 'forward',
  '9': 'turnR',
};

/** 物理テンキー演算子(location=3): get/put/use/equip。 */
const NUMPAD_OP_COMMAND: Record<string, SimpleCommandName> = {
  '+': 'get',
  '-': 'put',
  '*': 'use',
  '/': 'equip',
};

/** カーソルキー → 移動アクション。northFix で分岐(turn時=回転, 固定時=絶対移動)。 */
const CURSOR_TURN: Record<string, MoveAction> = {
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'turnL',
  ArrowRight: 'turnR',
};
const CURSOR_NF: Record<string, MoveAction> = {
  ArrowUp: 'absN',
  ArrowDown: 'absS',
  ArrowLeft: 'absW',
  ArrowRight: 'absE',
};

// ----------------------------------------------------------------------------
// 無修飾コマンドキー(KeyBindNone) — 既知CommandNameはそれを、他はrawで送出。
// ----------------------------------------------------------------------------

/** 既知 CommandName への直接マップ(無修飾)。レイアウト共通。 */
const COMMAND_KNOWN_WASD: Record<string, SimpleCommandName> = {
  b: 'board',
  g: 'equip',
  u: 'unequip',
  v: 'sort',
  z: 'get',
  o: 'put',
};
const COMMAND_KNOWN_NUMPAD: Record<string, SimpleCommandName> = {
  b: 'board',
  q: 'equip',
  w: 'unequip',
  v: 'sort',
  z: 'get',
  x: 'put',
};

/** raw で送る無修飾コマンド(既知CommandNameに無い語)。レイアウト別。 */
const COMMAND_RAW_WASD: Record<string, string> = {
  c: 'use',
  f: 'write',
  h: 'hi',
  j: 'erase',
  k: 'floor item',
  m: 'check\nlook',
  n: 'n',
  r: 'spells',
  t: '#ex-map style=turn',
  y: 'y',
};
const COMMAND_RAW_NUMPAD: Record<string, string> = {
  a: 'read',
  c: 'use',
  d: 'erase',
  f: 'floor item',
  h: 'hi',
  m: 'check\nlook',
  n: 'n',
  r: 'spells',
  s: 'write',
  t: '#ex-map style=turn',
  y: 'y',
};

// ----------------------------------------------------------------------------
// 解決ロジック
// ----------------------------------------------------------------------------

/** テンキー位置か(numpad)。 */
function isNumpadKey(ev: KeyboardEvent): boolean {
  return ev.location === 3;
}

/** 抽象移動アクション → intent(northFix で分岐)。 */
function actionToIntent(action: MoveAction, northFix: boolean): KeyIntent {
  switch (action) {
    case 'turnL':
      return { type: 'move', mode: 'turn', dir: 'l' };
    case 'turnR':
      return { type: 'move', mode: 'turn', dir: 'r' };
    case 'turnB':
      return { type: 'move', mode: 'turn', dir: 'b' };
    case 'absN':
      return { type: 'move', mode: 'step', dir: 'N' };
    case 'absS':
      return { type: 'move', mode: 'step', dir: 'S' };
    case 'absW':
      return { type: 'move', mode: 'step', dir: 'W' };
    case 'absE':
      return { type: 'move', mode: 'step', dir: 'E' };
    case 'forward':
      return northFix
        ? { type: 'move', mode: 'step', dir: 'N' }
        : { type: 'move', mode: 'step', dir: 'F' };
    case 'back':
      return northFix
        ? { type: 'move', mode: 'step', dir: 'S' }
        : { type: 'move', mode: 'step', dir: 'B' };
    case 'strafeL':
      return northFix
        ? { type: 'move', mode: 'step', dir: 'W' }
        : { type: 'move', mode: 'strafe', dir: 'L' };
    case 'strafeR':
      return northFix
        ? { type: 'move', mode: 'step', dir: 'E' }
        : { type: 'move', mode: 'strafe', dir: 'R' };
  }
}

/** ファンクションキー(F1-F12) → magic/shortcut intent。 */
function resolveFunctionKey(k: string, ctx: KeyContext): KeyIntent | null {
  const m = /^F([1-9]|1[0-2])$/.exec(k);
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 1 && n <= 7) {
    const spell = ctx.magic[k];
    if (spell) return { type: 'command', name: 'castMagic', spell };
    return null;
  }
  // F8-F12: shortcut(raw コマンド語)
  const cmd = ctx.shortcuts[k];
  if (cmd) return { type: 'command', name: 'raw', text: cmd };
  return null;
}

/**
 * キーイベント → intent。解決できなければ null(=ハンドラはイベントを消費しない)。
 */
export function resolveKey(ev: KeyboardEvent, ctx: KeyContext): KeyIntent | null {
  // 入力欄フォーカス時はゲームキー全無効(誤爆防止)
  if (ctx.inputFocused) return null;

  const k = ev.key;

  // ファンクションキーはリスト/通常を問わず最優先
  const fn = resolveFunctionKey(k, ctx);
  if (fn) return fn;

  // ---- リストモード: 数字選択 / cancel / all ----
  if (ctx.listActive) {
    if (/^[1-9]$/.test(k)) {
      return { type: 'list.select', value: Number(k) };
    }
    if (k === '0' || k === 'Escape') {
      return { type: 'list.select', value: 'cancel' };
    }
    if (k === '+') {
      return { type: 'list.select', value: 'all' };
    }
    // リスト中は移動・コマンドキーを消費しない
    return null;
  }

  // ---- 攻撃(hit): Space ----
  if (k === ' ' || k === 'Spacebar') {
    return { type: 'command', name: 'hit' };
  }

  // ---- カーソルキー(常時有効) ----
  if (k in CURSOR_TURN) {
    const action = ctx.northFix ? CURSOR_NF[k] : CURSOR_TURN[k];
    return actionToIntent(action, ctx.northFix);
  }

  const lower = k.length === 1 ? k.toLowerCase() : k;

  // ---- 物理テンキー(常時有効) ----
  if (isNumpadKey(ev)) {
    if (k in NUMPAD_KEY_MOVE) {
      return actionToIntent(NUMPAD_KEY_MOVE[k], ctx.northFix);
    }
    if (k in NUMPAD_OP_COMMAND) {
      return { type: 'command', name: NUMPAD_OP_COMMAND[k] };
    }
  }

  // ---- レイアウト別 文字キー移動 ----
  const moveTable = ctx.layout === 'wasd' ? WASD_MOVE : NUMPAD_LETTER_MOVE;
  if (lower in moveTable) {
    return actionToIntent(moveTable[lower], ctx.northFix);
  }

  // ---- レイアウト別 無修飾コマンドキー ----
  const known = ctx.layout === 'wasd' ? COMMAND_KNOWN_WASD : COMMAND_KNOWN_NUMPAD;
  if (lower in known) {
    return { type: 'command', name: known[lower] };
  }
  const raw = ctx.layout === 'wasd' ? COMMAND_RAW_WASD : COMMAND_RAW_NUMPAD;
  if (lower in raw) {
    return { type: 'command', name: 'raw', text: raw[lower] };
  }

  return null;
}
