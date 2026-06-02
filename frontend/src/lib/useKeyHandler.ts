/**
 * F8 キーハンドラの React 配線。
 * document keydown を購読し resolveKey で intent へ解決、controller へ送る。
 *
 * - inputFocused 判定: document.activeElement が入力系(input/textarea/select/contentEditable)。
 * - intent 解決時は preventDefault(ブラウザ既定動作・スクロール抑止)。
 * - 文脈(layout/northFix/listActive/magic/shortcuts)は各 store から組み立て。
 */
import { useEffect } from 'react';
import type { WsController } from '../ws/controller';
import { resolveKey, type KeyContext, type KeyLayout } from './keyHandler';
import { useListStore } from '../stores/listStore';
import { useEditStore } from '../stores/editStore';
import { useMapStore } from '../stores/mapStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { DisplaySettings } from '../stores/settingsStore';

/** keybind scope の形([12]§3.1)。 */
interface KeybindSettings {
  layout?: KeyLayout;
  magic?: Record<string, string | null>;
  shortcuts?: Record<string, string | null>;
  altG?: string;
}

/** 入力系要素にフォーカスがあるか。 */
function isInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/** intent を controller の送信ヘルパへディスパッチ。 */
function dispatch(
  controller: WsController,
  session: string,
  intent: ReturnType<typeof resolveKey>,
): void {
  if (!intent) return;
  switch (intent.type) {
    case 'move':
      controller.sendMove(session, { dir: intent.dir, mode: intent.mode });
      break;
    case 'list.select':
      controller.sendListSelect(session, intent.value);
      break;
    case 'command':
      if (intent.name === 'castMagic') {
        controller.sendCommand(session, { name: 'castMagic', spell: intent.spell });
      } else if (intent.name === 'raw') {
        controller.sendCommand(session, { name: 'raw', text: intent.text });
      } else {
        controller.sendCommand(session, { name: intent.name });
      }
      break;
  }
}

/**
 * アクティブ session のキーハンドラを document に配線する。
 * session 無し(ログイン画面)では何もしない。
 */
export function useKeyHandler(
  controller: WsController,
  session: string | null,
): void {
  const list = useListStore((s) => (session ? s.bySession[session] : undefined));
  const edit = useEditStore((s) => (session ? s.bySession[session] : undefined));
  const keybind = useSettingsStore((s) => s.byScope['keybind'] as KeybindSettings | undefined);
  const display = useSettingsStore((s) => s.byScope['display'] as DisplaySettings | undefined);
  // 北固定判定は**サーバの実マップstyle**(ライブ)を最優先([07]§6.2 map.style)。
  // 設定(display)が未取得でも、現在のマップが solid なら北固定操作にする。
  // (従来は display 未取得時 undefined→turn操作になり、北固定なのに左右逆だった)
  const mapStyle = useMapStore((s) => (session ? s.bySession[session]?.style : undefined));

  useEffect(() => {
    if (!session) return;

    const handler = (ev: KeyboardEvent) => {
      // style 解決順: ライブmap.style → 設定display → 既定'solid'。
      const effStyle = mapStyle ?? display?.mapStyle ?? 'solid';
      const ctx: KeyContext = {
        layout: keybind?.layout ?? 'numpad',
        // 北固定: style === 'solid'(turn=視点固定)。([07]§6.2, key_handler north_fix)
        northFix: effStyle === 'solid',
        listActive: list?.active ?? false,
        inputFocused: isInputFocused(),
        magic: keybind?.magic ?? {},
        shortcuts: keybind?.shortcuts ?? {},
        altG: keybind?.altG,
      };
      // 編集ダイアログ表示中はゲームキー無効(編集UI側でキー処理)
      // ゲームキー無効化は **複数行編集(#m-edit)モーダル表示中のみ**。
      // #s-edit(1行)はPHIの通常入力待ち状態でモーダルも出ない(下部入力欄で応答)
      // ため、テンキー等の移動キーは有効のまま(s-editでテンキーが効かない不具合の修正)。
      if (edit?.active && edit.mode === 'multi' && !ctx.listActive) return;

      const intent = resolveKey(ev, ctx);
      if (intent) {
        ev.preventDefault();
        dispatch(controller, session, intent);
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [controller, session, list?.active, edit?.active, edit?.mode, keybind, display, mapStyle]);
}
