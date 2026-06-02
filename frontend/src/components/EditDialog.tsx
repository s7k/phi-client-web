/**
 * F9: 入力ダイアログ([05]§4, [07]§6.8/§5.6)。
 * - editStore が active のとき表示。single=1行入力, multi=複数行エディタ。
 * - 確定→edit.submit(mode, lines)。multi各行+終端`.`整形はBE責務(A: FEはlines送出)。
 * - キャンセル→edit.cancel(multi=`.!`, single=空送信はBE整形)。
 */
import { useState } from 'react';
import { useWs } from '../ws/WsContext';
import { useEditStore } from '../stores/editStore';
import './EditDialog.css';

export function EditDialog({ session }: { session: string }) {
  const ws = useWs();
  const edit = useEditStore((s) => s.bySession[session]);
  const closeEdit = useEditStore((s) => s.close);
  const [value, setValue] = useState('');

  if (!edit?.active || !edit.mode) return null;
  const multi = edit.mode === 'multi';

  function submit() {
    // single=1行、multi=改行分割(空末尾は除去)
    const lines = multi
      ? value.replace(/\n+$/, '').split('\n')
      : [value];
    ws.submitEdit(session, edit!.mode as 'single' | 'multi', lines);
    setValue('');
    // BE の edit end 応答を待たずローカルで即クローズ(後続 edit end は無害)。
    closeEdit(session);
  }
  function cancel() {
    ws.cancelEdit(session);
    setValue('');
    closeEdit(session);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    // single: Enter で確定。multi: Enterは改行、Ctrl+Enterで確定。
    if (e.key === 'Enter') {
      if (!multi || e.ctrlKey) {
        e.preventDefault();
        submit();
      }
    }
  }

  return (
    <div className="editdialog" role="dialog" aria-modal="true" aria-label="入力">
      <div className="editdialog__box">
        <p className="editdialog__title">
          {multi ? '複数行入力' : '入力'}
        </p>
        {multi ? (
          <textarea
            className="editdialog__textarea"
            aria-label="入力本文"
            rows={6}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <input
            className="editdialog__input"
            aria-label="入力本文"
            type="text"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        <div className="editdialog__actions">
          <button type="button" className="editdialog__cancel" onClick={cancel}>
            キャンセル
          </button>
          <button type="button" className="editdialog__submit" onClick={submit}>
            確定{multi ? ' (Ctrl+Enter)' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
