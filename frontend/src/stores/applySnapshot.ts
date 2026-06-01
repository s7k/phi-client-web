/**
 * snapshot 適用([07]§4.2, [12]§5)。
 * 再アタッチ時に map/status/cond/userList/mode を **全置換**で画面復元。
 * chat は追記方針のため snapshot では触らない(温存)。
 *
 * 注: userList/mode store は本ラウンド未実装。受信時はスキップ(後続ラウンドで配線)。
 */
import type { SnapshotEvent } from '../types/protocol';
import { useMapStore } from './mapStore';
import { useStatusStore } from './statusStore';

export function applySnapshot(session: string, snap: SnapshotEvent): void {
  if (snap.map) {
    useMapStore.getState().setMap(session, snap.map);
  }
  if (snap.status) {
    useStatusStore.getState().setStatus(session, snap.status);
  }
  if (snap.cond) {
    useStatusStore.getState().setCond(session, snap.cond);
  }
  // TODO(R1+): userList → userStore, mode → modeStore, notice → uiStore。
}
