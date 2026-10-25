/**
 * F7: チャット。
 * - ログ表示(chatStore, markup解析→装飾レンダリング)。
 * - 発言種別UI: 通常/大声/パーティー/全タブ/priv(宛先選択)。
 * - chat intent 送信。大声は確認ダイアログ([05]§1)。
 */
import { useState, useEffect, useRef } from 'react';
import { useWs } from '../ws/WsContext';
import { useChatStore } from '../stores/chatStore';
import { useUserStore } from '../stores/userStore';
import { useUiStore } from '../stores/uiStore';
import type { ChatMode } from '../types/protocol';
import { MarkupText } from './MarkupText';
import { GameCommands } from './CommandBar';
import './Chat.css';

const MODE_LABELS: { mode: ChatMode; label: string }[] = [
  { mode: 'normal', label: '通常' },
  { mode: 'loud', label: '大声' },
  { mode: 'party', label: 'パーティー' },
  { mode: 'all', label: '全タブ' },
  { mode: 'priv', label: 'プライベート' },
];

/** 入力履歴に残す件数。Philly の EditMaxLine 既定と同じ。 */
const HISTORY_MAX = 50;

export function Chat({ session }: { session: string }) {
  const ws = useWs();
  const log = useChatStore((s) => s.bySession[session] ?? []);
  const users = useUserStore((s) => s.bySession[session] ?? []);

  // 新着で最下部へ自動スクロール(ユーザーがスクロールせずに最新ログを見られる)。
  const logRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, session]);

  const chatMode = useUiStore((s) => s.chatMode);
  const setChatMode = useUiStore((s) => s.setChatMode);
  const privTo = useUiStore((s) => s.privTo);
  const setPrivTo = useUiStore((s) => s.setPrivTo);
  const openConfirm = useUiStore((s) => s.openConfirm);

  const [text, setText] = useState('');
  // 送った発言の履歴(↑↓で呼び戻す)。cursor は履歴上の位置で、末尾=新しい入力。
  const history = useRef<string[]>([]);
  const cursor = useRef(0);

  function doSend(mode: ChatMode = chatMode) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (mode === 'priv' && !privTo) return;
    ws.sendChat(session, mode, trimmed, privTo ?? undefined);
    const h = history.current;
    if (h[h.length - 1] !== trimmed) h.push(trimmed);
    if (h.length > HISTORY_MAX) h.shift();
    cursor.current = h.length;
    setText('');
  }

  /** ↑↓で履歴、Ctrl+Enter でパーティー発言(Philly の PartyTalkByCtrl)。 */
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    const h = history.current;
    if (e.key === 'ArrowUp' && cursor.current > 0) {
      e.preventDefault();
      cursor.current -= 1;
      setText(h[cursor.current]);
    } else if (e.key === 'ArrowDown' && cursor.current < h.length) {
      e.preventDefault();
      cursor.current += 1;
      setText(h[cursor.current] ?? '');
    } else if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      doSend('party');
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (chatMode === 'loud') {
      // 大声は誤爆防止の確認ダイアログ([05]§1)
      openConfirm({
        message: `大声で発言します:\n"${trimmed}"\nよろしいですか?`,
        onConfirm: () => doSend(),
      });
      return;
    }
    doSend();
  }

  return (
    <div className="chat">
      <ul className="chat__log" aria-label="チャットログ" ref={logRef}>
        {log.map((m) => (
          <li key={m._id} className={`chat__line chat__line--${m.channel}`}>
            {m.from && <span className="chat__from">{m.from}</span>}
            <span className="chat__text">
              <MarkupText text={m.text} markup={m.markup} />
            </span>
          </li>
        ))}
      </ul>

      <form className="chat__compose" onSubmit={handleSubmit}>
        <div className="chat__modes">
          {MODE_LABELS.map((m) => (
            <button
              type="button"
              key={m.mode}
              className={
                'chat__mode' + (chatMode === m.mode ? ' chat__mode--active' : '')
              }
              onClick={() => setChatMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
          <div className="chat__commands">
            <GameCommands session={session} />
          </div>
        </div>

        {chatMode === 'priv' && (
          <select
            className="chat__priv-to"
            aria-label="宛先"
            value={privTo ?? ''}
            onChange={(e) => setPrivTo(e.target.value || null)}
          >
            <option value="">宛先を選択</option>
            {users.map((u) => (
              <option key={u.key} value={u.key}>
                {u.name}
              </option>
            ))}
          </select>
        )}

        <div className="chat__input-row">
          <input
            className="chat__input"
            type="text"
            value={text}
            placeholder="メッセージを入力"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="chat__send"
            type="submit"
            disabled={
              !text.trim() || (chatMode === 'priv' && !privTo)
            }
          >
            送信
          </button>
        </div>
      </form>
    </div>
  );
}
