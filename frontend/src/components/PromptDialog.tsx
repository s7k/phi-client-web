/**
 * 1行入力ダイアログ(uiStore.prompt 駆動)。pay の金額入力等。
 * 見た目は確認ダイアログと揃える。
 */
import { useEffect, useState } from 'react';
import { useUiStore } from '../stores/uiStore';
import './ConfirmDialog.css';

export function PromptDialog() {
  const prompt = useUiStore((s) => s.prompt);
  const close = useUiStore((s) => s.closePrompt);
  const [value, setValue] = useState('');

  // 開き直したら入力を空にする
  useEffect(() => setValue(''), [prompt]);

  if (!prompt) return null;
  const valid = prompt.numeric ? /^\d+$/.test(value) : value.trim() !== '';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !prompt) return;
    prompt.onSubmit(value.trim());
    close();
  }

  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label={prompt.message}>
      <form className="confirm-box" onSubmit={submit}>
        <label className="confirm-msg" style={{ display: 'block' }}>
          {prompt.message}
          <input
            autoFocus
            inputMode={prompt.numeric ? 'numeric' : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && close()}
            style={{ display: 'block', width: '100%', marginTop: '0.5rem', boxSizing: 'border-box' }}
          />
        </label>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={close}>
            キャンセル
          </button>
          <button type="submit" className="confirm-ok" disabled={!valid}>
            OK
          </button>
        </div>
      </form>
    </div>
  );
}
