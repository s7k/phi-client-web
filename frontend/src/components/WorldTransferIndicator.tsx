/**
 * 世界移動の進行表示(CR-3, [07]§6.10)。FEは進行表示のみ(ハンドシェイクはBE)。
 * start=移動中インジケータ、success/fail=結果を一時表示。
 */
import { useUiStore } from '../stores/uiStore';

export function WorldTransferIndicator() {
  const transfer = useUiStore((s) => s.worldTransfer);
  if (!transfer) return null;

  const text =
    transfer.state === 'start'
      ? '世界移動中…'
      : transfer.state === 'success'
        ? '世界移動完了'
        : '世界移動失敗';

  return (
    <div
      className={`world-transfer world-transfer--${transfer.state}`}
      role="status"
      data-testid="world-transfer"
    >
      {transfer.state === 'start' && <span className="world-transfer__spinner" />}
      <span className="world-transfer__text">{text}</span>
      {transfer.server && (
        <span className="world-transfer__server">{transfer.server}</span>
      )}
    </div>
  );
}
