/**
 * スマホ用タッチ操作パッド(方向カーソル)。
 *
 * - スマホ(<=820px)のみ表示(CSS)。デスクトップはキーボード(F8 useKeyHandler)で操作。
 * - マップ領域(.game__map, position:relative)の右下に半透明オーバーレイ。
 * - 移動の向き解決は keyHandler.actionToIntent を再利用し、北固定/turn の整合を保つ
 *   (キーボード操作と同一ロジック)。
 *
 * 配置(3x3):
 *   ↺  ▲  ↻
 *   ◀  ⚔  ▶
 *      ▼
 */
import { useWs } from '../ws/WsContext';
import { useMapStore } from '../stores/mapStore';
import { actionToIntent, type MoveAction } from '../lib/keyHandler';
import './TouchControls.css';

export function TouchControls({ session }: { session: string }) {
  const ws = useWs();
  // 北固定判定はライブ map.style(useKeyHandler と同一基準)。既定 solid=北固定。
  const style = useMapStore((s) => s.bySession[session]?.style);
  const northFix = (style ?? 'solid') === 'solid';

  function move(action: MoveAction) {
    const intent = actionToIntent(action, northFix);
    if (intent.type === 'move') {
      ws.sendMove(session, { dir: intent.dir, mode: intent.mode });
    }
  }

  return (
    <div className="touch-controls" role="group" aria-label="操作パッド">
      <button className="tc tc--tl" type="button" aria-label="左回転"
        onClick={() => move('turnL')}>↺</button>
      <button className="tc tc--up" type="button" aria-label="前進"
        onClick={() => move('forward')}>▲</button>
      <button className="tc tc--tr" type="button" aria-label="右回転"
        onClick={() => move('turnR')}>↻</button>
      <button className="tc tc--l" type="button" aria-label="左へ"
        onClick={() => move('strafeL')}>◀</button>
      <button className="tc tc--c" type="button" aria-label="攻撃"
        onClick={() => ws.sendCommand(session, { name: 'hit' })}>⚔</button>
      <button className="tc tc--r" type="button" aria-label="右へ"
        onClick={() => move('strafeR')}>▶</button>
      <button className="tc tc--dn" type="button" aria-label="後退"
        onClick={() => move('back')}>▼</button>
    </div>
  );
}
