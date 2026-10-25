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
 * - Shift+1〜7=magic(keybind.magic→castMagic), Shift+8・9・0=shortcuts(raw command)。
 *   F キーはブラウザ/OS が使う(F5 再読み込み、F11 全画面、F12 開発者ツール等)為、割り当てない。
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
  /** 割当枠 F1-F7 → 呪文名(keybind.magic)。Shift+1〜7 で呼ぶ。 */
  magic: Partial<Record<string, string | null>>;
  /** 割当枠 F8-F10 → コマンド語(keybind.shortcuts)。Shift+8・9・0 で呼ぶ。 */
  shortcuts: Partial<Record<string, string | null>>;
  /** Shift+G に割り当てる raw コマンド語(keybind.altG)。空/未設定で無効。 */
  altG?: string;
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
export type MoveAction =
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
  y: 'y',
};

// ----------------------------------------------------------------------------
// 解決ロジック
// ----------------------------------------------------------------------------

/** テンキー位置か(numpad)。 */
function isNumpadKey(ev: KeyboardEvent): boolean {
  return ev.location === 3;
}

/** 抽象移動アクション → intent(northFix で分岐)。タッチ操作(TouchControls)でも再利用。 */
export function actionToIntent(action: MoveAction, northFix: boolean): KeyIntent {
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

/**
 * Shift+数字 → 割当枠。設定の保存キーは F キーで割り当てていた頃の名前(F1〜F10)のまま使う。
 * 記号はキーボード配列で変わる為、物理キー位置(code)で判定する。
 */
export const SHIFT_DIGIT_SLOT: Readonly<Record<string, string>> = {
  Digit1: 'F1',
  Digit2: 'F2',
  Digit3: 'F3',
  Digit4: 'F4',
  Digit5: 'F5',
  Digit6: 'F6',
  Digit7: 'F7',
  Digit8: 'F8',
  Digit9: 'F9',
  Digit0: 'F10',
};

/** 割当枠(F1〜F10) → 押すキーの表示名(Shift+1〜Shift+0)。 */
export function slotKeyLabel(slot: string): string {
  const code = Object.keys(SHIFT_DIGIT_SLOT).find((c) => SHIFT_DIGIT_SLOT[c] === slot);
  return code ? `Shift+${code.slice('Digit'.length)}` : slot;
}

/** Shift+数字 → magic/shortcut intent。 */
function resolveShiftDigit(ev: KeyboardEvent, ctx: KeyContext): KeyIntent | null {
  if (!ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  const slot = SHIFT_DIGIT_SLOT[ev.code];
  if (!slot) return null;
  const spell = ctx.magic[slot];
  if (spell) return { type: 'command', name: 'castMagic', spell };
  const cmd = ctx.shortcuts[slot];
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

  // Shift+数字(魔法・ショートカット)はリスト/通常を問わず最優先
  const slot = resolveShiftDigit(ev, ctx);
  if (slot) return slot;

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

  // ---- Shift+G: ユーザー設定 altG の raw コマンド語(無修飾 g=equip より優先) ----
  if (ev.shiftKey && lower === 'g' && ctx.altG) {
    return { type: 'command', name: 'raw', text: ctx.altG };
  }

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

// ----------------------------------------------------------------------------
// ヘルプ用のキー一覧。上の対応表から作るので、割当を変えるとヘルプも変わる。
// ----------------------------------------------------------------------------

/** ヘルプの1行。 */
export interface KeyHelpRow {
  keys: string;
  action: string;
}

/** ヘルプの1区分。 */
export interface KeyHelpGroup {
  title: string;
  rows: KeyHelpRow[];
}

const KEY_LABEL: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

const COMMAND_LABEL: Record<SimpleCommandName, string> = {
  board: '看板に注意 (board)',
  equip: '自動装備 (equip)',
  unequip: '装備を外す (unequip)',
  sort: '持ち物の整理 (sort)',
  get: '拾う (get)',
  put: '置く (put)',
  hit: '攻撃 (hit)',
  use: '使う (use)',
  read: '看板を読む (read)',
  write: '看板に書く (write)',
};

function keyLabel(k: string): string {
  return KEY_LABEL[k] ?? (k.length === 1 ? k.toUpperCase() : k);
}

function moveLabel(action: MoveAction, northFix: boolean): string {
  switch (action) {
    case 'turnL':
      return '左を向く';
    case 'turnR':
      return '右を向く';
    case 'turnB':
      return '後ろを向く';
    case 'absN':
      return '北へ';
    case 'absS':
      return '南へ';
    case 'absW':
      return '西へ';
    case 'absE':
      return '東へ';
    case 'forward':
      return northFix ? '北へ' : '前へ';
    case 'back':
      return northFix ? '南へ' : '後ろへ';
    case 'strafeL':
      return northFix ? '西へ' : '左へ平行移動';
    case 'strafeR':
      return northFix ? '東へ' : '右へ平行移動';
  }
}

/** 複数行のコマンド語は ↵ で区切って見せる。 */
function rawLabel(text: string): string {
  return `${text.replace(/\n/g, ' ↵ ')} を送る`;
}

function moveRows(table: Record<string, MoveAction>, northFix: boolean, prefix = ''): KeyHelpRow[] {
  return Object.entries(table).map(([k, a]) => ({
    keys: prefix + keyLabel(k),
    action: moveLabel(a, northFix),
  }));
}

/**
 * 現在の操作設定で使えるキーの一覧。
 * F1-F12・Shift+G は設定で割り当てたものだけ出す。
 */
export function describeKeys(
  ctx: Pick<KeyContext, 'layout' | 'northFix' | 'magic' | 'shortcuts' | 'altG'>,
): KeyHelpGroup[] {
  const { layout, northFix } = ctx;
  const letterMove = layout === 'wasd' ? WASD_MOVE : NUMPAD_LETTER_MOVE;
  const known = layout === 'wasd' ? COMMAND_KNOWN_WASD : COMMAND_KNOWN_NUMPAD;
  const raw = layout === 'wasd' ? COMMAND_RAW_WASD : COMMAND_RAW_NUMPAD;

  const fn: KeyHelpRow[] = [];
  for (const slot of Object.values(SHIFT_DIGIT_SLOT)) {
    const spell = ctx.magic[slot];
    const cmd = ctx.shortcuts[slot];
    if (spell) fn.push({ keys: slotKeyLabel(slot), action: `${spell} を唱える` });
    else if (cmd) fn.push({ keys: slotKeyLabel(slot), action: rawLabel(cmd) });
  }
  if (ctx.altG) fn.push({ keys: 'Shift+G', action: rawLabel(ctx.altG) });

  return [
    {
      title: `移動（${layout === 'wasd' ? 'WASD' : '仮想テンキー'}・${northFix ? '北固定' : '回転'}）`,
      rows: [
        ...moveRows(letterMove, northFix),
        ...moveRows(northFix ? CURSOR_NF : CURSOR_TURN, northFix),
        ...moveRows(NUMPAD_KEY_MOVE, northFix, 'テンキー'),
      ],
    },
    {
      title: '行動',
      rows: [
        { keys: 'Space', action: COMMAND_LABEL.hit },
        ...Object.entries(known).map(([k, n]) => ({ keys: keyLabel(k), action: COMMAND_LABEL[n] })),
        ...Object.entries(raw).map(([k, t]) => ({ keys: keyLabel(k), action: rawLabel(t) })),
        ...Object.entries(NUMPAD_OP_COMMAND).map(([k, n]) => ({
          keys: `テンキー${k}`,
          action: COMMAND_LABEL[n],
        })),
      ],
    },
    {
      title: 'リスト表示中',
      rows: [
        { keys: '1〜9', action: '番号を選ぶ（9 は次のページ）' },
        { keys: '0 / Esc', action: 'キャンセル' },
        { keys: '+', action: '全て選ぶ' },
      ],
    },
    {
      title: '魔法・ショートカット（設定で割り当て）',
      rows: fn.length ? fn : [{ keys: 'Shift+1〜0', action: '未割り当て。設定の「キーバインド」で決める' }],
    },
  ];
}
