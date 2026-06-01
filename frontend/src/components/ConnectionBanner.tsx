/**
 * 接続状態の帯 + 手動再接続ボタン(CR-15, [12]§6 再接続UX)。
 * socketState(connecting/reconnecting/open)を表示。再接続中は reconnectNow を提供。
 */
import { useWs } from '../ws/WsContext';
import { useConnectionStore } from '../stores/connectionStore';
import type { SocketState } from '../stores/connectionStore';

const LABEL: Record<SocketState, string> = {
  idle: '未接続',
  connecting: '接続中…',
  open: '接続済み',
  reconnecting: '再接続中…',
  closed: '切断',
};

export function ConnectionBanner() {
  const ws = useWs();
  const socketState = useConnectionStore((s) => s.socketState);

  // 接続済み(open)は帯を出さない(常時表示はノイズ)。
  if (socketState === 'open') return null;

  const showReconnect =
    socketState === 'reconnecting' || socketState === 'closed';

  return (
    <div
      className={`conn-banner conn-banner--${socketState}`}
      role="status"
      data-testid="conn-banner"
    >
      <span className="conn-banner__label">{LABEL[socketState]}</span>
      {showReconnect && (
        <button
          type="button"
          className="conn-banner__reconnect"
          onClick={() => ws.reconnectNow()}
        >
          今すぐ再接続
        </button>
      )}
    </div>
  );
}
