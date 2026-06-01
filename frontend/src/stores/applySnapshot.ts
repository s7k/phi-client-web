/**
 * snapshot 適用([07]§4.2, [12]§5, DEVLOG A-04)。
 * 再アタッチ時に map/status/cond/userList/mode/list/edit を **全置換**で画面復元。
 * chat は追記方針のため snapshot では触らない(温存)。
 */
import type { SnapshotEvent } from '../types/protocol';
import { useMapStore } from './mapStore';
import { useStatusStore } from './statusStore';
import { useUserStore } from './userStore';
import { useModeStore } from './modeStore';
import { useListStore } from './listStore';
import { useEditStore } from './editStore';

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
  if (snap.userList) {
    useUserStore.getState().setUsers(session, snap.userList);
  }
  if (snap.mode) {
    useModeStore.getState().setMode(session, snap.mode);
  }
  // A-04: list/edit はアクティブな対話状態がある場合のみ含まれる。
  if (snap.list) {
    useListStore.getState().setList(session, snap.list);
  }
  if (snap.edit) {
    useEditStore.getState().setEdit(session, snap.edit);
  }
}
