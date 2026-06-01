/**
 * 確認ダイアログ(uiStore.confirm 駆動)。大声誤爆防止等([05]§1)。
 */
import { useUiStore } from '../stores/uiStore';
import './ConfirmDialog.css';

export function ConfirmDialog() {
  const confirm = useUiStore((s) => s.confirm);
  const close = useUiStore((s) => s.closeConfirm);

  if (!confirm) return null;

  function handleConfirm() {
    confirm!.onConfirm();
    close();
  }
  function handleCancel() {
    confirm!.onCancel?.();
    close();
  }

  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true">
      <div className="confirm-box">
        <p className="confirm-msg">{confirm.message}</p>
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={handleCancel}>
            キャンセル
          </button>
          <button className="confirm-ok" onClick={handleConfirm}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
