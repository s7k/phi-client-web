/**
 * uiStore — クライアント体験のローカルUI状態([12]§5)。
 * 更新元: ローカル(イベント駆動しない)。
 * フォーカスtab・チャット発言種別・priv宛先・確認ダイアログ等。
 */
import { create } from 'zustand';
import type { ChatMode } from '../types/protocol';

/** 確認ダイアログ要求(大声誤爆防止等, [05]§1)。 */
export interface ConfirmDialog {
  message: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

interface UiStoreState {
  /** 表示中タブ(session)。null=ログイン/キャラ選択画面。 */
  activeTab: string | null;
  /** チャット発言種別。 */
  chatMode: ChatMode;
  /** priv宛先 userKey(chatMode='priv' 時)。 */
  privTo: string | null;
  /** 表示中の確認ダイアログ(null=非表示)。 */
  confirm: ConfirmDialog | null;
  /** 設定パネル(F10)表示中か。 */
  settingsOpen: boolean;

  setActiveTab: (tab: string | null) => void;
  setChatMode: (mode: ChatMode) => void;
  setPrivTo: (to: string | null) => void;
  openConfirm: (dialog: ConfirmDialog) => void;
  closeConfirm: () => void;
  setSettingsOpen: (open: boolean) => void;
  reset: () => void;
}

const initial = {
  activeTab: null as string | null,
  chatMode: 'normal' as ChatMode,
  privTo: null as string | null,
  confirm: null as ConfirmDialog | null,
  settingsOpen: false,
};

export const useUiStore = create<UiStoreState>((set) => ({
  ...initial,
  setActiveTab: (activeTab) => set({ activeTab }),
  setChatMode: (chatMode) => set({ chatMode }),
  setPrivTo: (privTo) => set({ privTo }),
  openConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  reset: () => set({ ...initial }),
}));
