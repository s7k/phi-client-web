// stores 公開エントリ。
export { useConnectionStore } from './connectionStore';
export { useSessionStore } from './sessionStore';
export { useMapStore } from './mapStore';
export { useStatusStore } from './statusStore';
export { useChatStore } from './chatStore';
export { useListStore } from './listStore';
export { useEditStore } from './editStore';
export { useUserStore } from './userStore';
export { useModeStore } from './modeStore';
export { useUiStore } from './uiStore';
export { useSettingsStore } from './settingsStore';
export { useEagleEyeStore } from './eagleEyeStore';
export { useNoticeStore } from './noticeStore';
export { applySnapshot } from './applySnapshot';

import { useConnectionStore } from './connectionStore';
import { useSessionStore } from './sessionStore';
import { useMapStore } from './mapStore';
import { useStatusStore } from './statusStore';
import { useChatStore } from './chatStore';
import { useListStore } from './listStore';
import { useEditStore } from './editStore';
import { useUserStore } from './userStore';
import { useModeStore } from './modeStore';
import { useEagleEyeStore } from './eagleEyeStore';
import { useNoticeStore } from './noticeStore';

/**
 * session 単位の全ゲーム状態を破棄(logout / 全セッション破棄時)。
 * 各 store の bySession 残留(state leak)を防ぐ。別キャラ再接続で前キャラの
 * map/status/chat 等が復活する不具合への対策。
 * connectionStore は **socketState を維持**(logout では WS を切断しないため)し、
 * session 別レガシー接続 state のみクリアする。
 * 注: settings / ui は アカウント/画面状態のため呼び出し側(logout)で別途 reset。
 */
export function resetSessionState(): void {
  useMapStore.getState().reset();
  useStatusStore.getState().reset();
  useChatStore.getState().reset();
  useListStore.getState().reset();
  useEditStore.getState().reset();
  useUserStore.getState().reset();
  useModeStore.getState().reset();
  useEagleEyeStore.getState().reset();
  useNoticeStore.getState().reset();
  useSessionStore.getState().reset();
  // 接続: socketState は保持し、session 別接続 state のみ破棄。
  const conn = useConnectionStore.getState();
  const sock = conn.socketState;
  conn.reset();
  conn.setSocketState(sock);
}
