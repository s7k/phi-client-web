/**
 * F7: チャット。
 * - ログ表示(chatStore, markup解析→装飾レンダリング)。
 * - 発言種別UI: 通常/大声/パーティー/全タブ/priv(宛先選択)。
 * - chat intent 送信。大声は確認ダイアログ([05]§1)。
 */
import { useState } from 'react';
import { useWs } from '../ws/WsContext';
import { useChatStore } from '../stores/chatStore';
import { useUserStore } from '../stores/userStore';
import { useUiStore } from '../stores/uiStore';
import type { ChatMode } from '../types/protocol';
import { MarkupText } from './MarkupText';
import './Chat.css';

const MODE_LABELS: { mode: ChatMode; label: string }[] = [
  { mode: 'normal', label: '通常' },
  { mode: 'loud', label: '大声' },
  { mode: 'party', label: 'パーティー' },
  { mode: 'all', label: '全タブ' },
  { mode: 'priv', label: 'プライベート' },
];

export function Chat({ session }: { session: string }) {
  const ws = useWs();
  const log = useChatStore((s) => s.bySession[session] ?? []);
  const users = useUserStore((s) => s.bySession[session] ?? []);

  const chatMode = useUiStore((s) => s.chatMode);
  const setChatMode = useUiStore((s) => s.setChatMode);
  const privTo = useUiStore((s) => s.privTo);
  const setPrivTo = useUiStore((s) => s.setPrivTo);
  const openConfirm = useUiStore((s) => s.openConfirm);

  const [text, setText] = useState('');

  function doSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (chatMode === 'priv' && !privTo) return;
    ws.sendChat(session, chatMode, trimmed, privTo ?? undefined);
    setText('');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (chatMode === 'loud') {
      // 大声は誤爆防止の確認ダイアログ([05]§1)
      openConfirm({
        message: `大声で発言します:\n"${trimmed}"\nよろしいですか?`,
        onConfirm: doSend,
      });
      return;
    }
    doSend();
  }

  return (
    <div className="chat">
      <ul className="chat__log" aria-label="チャットログ">
        {log.map((m, i) => (
          <li key={i} className={`chat__line chat__line--${m.channel}`}>
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
