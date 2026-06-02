/**
 * settingsStore — scope別 設定([12]§3, §5)。
 * 更新元: settings(SQLite同期)。
 * scope: keybind / notify / display / intervals。値はBE/FE共通JSON。
 */
import { create } from 'zustand';
import type { SettingsScope } from '../types/protocol';

/** keybind scope([12]§3.1)。F1-F7=呪文名 / F8-F12=コマンド語 / altG=Shift+G語。 */
export interface KeybindSettings {
  layout: 'wasd' | 'numpad';
  /** F1-F7 → 呪文名(null=未割当)。 */
  magic: Record<string, string | null>;
  /** F8-F12 → コマンド語(null=未割当)。 */
  shortcuts: Record<string, string | null>;
  /** Shift+G ショートカット語。 */
  altG: string;
}

/** notify scope([12]§3.2, [05]§10)。 */
export interface NotifySettings {
  enabled: boolean;
  /** priv のみ通知。 */
  privOnly: boolean;
  /** 大声(loud)を通知対象に含める。 */
  loud: boolean;
  /** 含めるパターン(正規表現文字列)。null=無効。 */
  regexInclude: string | null;
  /** 除外パターン(正規表現文字列)。null=無効。 */
  regexExclude: string | null;
  sound: boolean;
  titleFlash: boolean;
}

/** display scope の既定値([12]§3.3)。 */
export interface DisplaySettings {
  mapSize: 40 | 57;
  mapStyle: 'turn' | 'solid';
  eagleEye: boolean;
  fontScale: number;
  theme: 'dark' | 'light';
}

/** intervals scope([12]§3.4)。#map-iv / #status-iv。 */
export interface IntervalsSettings {
  mapUpdate: number;
  statusUpdate: number;
}

/** 各scope既定値([12]§3)。settings 未取得時のフォールバック。 */
export const DEFAULT_KEYBIND: KeybindSettings = {
  // PHI Client デフォルトは仮想Numpad(789uiojklm,.)。既定を numpad に。
  layout: 'numpad',
  magic: { F1: null, F2: null, F3: null, F4: null, F5: null, F6: null, F7: null },
  shortcuts: { F8: null, F9: null, F10: null, F11: null, F12: null },
  altG: '',
};

export const DEFAULT_NOTIFY: NotifySettings = {
  enabled: true,
  privOnly: false,
  loud: true,
  regexInclude: null,
  regexExclude: null,
  sound: true,
  titleFlash: true,
};

export const DEFAULT_DISPLAY: DisplaySettings = {
  mapSize: 57,
  mapStyle: 'solid',
  eagleEye: false,
  fontScale: 1.0,
  theme: 'dark',
};

export const DEFAULT_INTERVALS: IntervalsSettings = {
  mapUpdate: 10,
  statusUpdate: 10,
};

interface SettingsStoreState {
  /** scope → 値(任意JSON)。 */
  byScope: Partial<Record<SettingsScope, unknown>>;
  setScope: (scope: SettingsScope, value: unknown) => void;
  getScope: <T = unknown>(scope: SettingsScope) => T | undefined;
  reset: () => void;
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  byScope: {},
  setScope: (scope, value) =>
    set((s) => ({ byScope: { ...s.byScope, [scope]: value } })),
  getScope: <T = unknown>(scope: SettingsScope) =>
    get().byScope[scope] as T | undefined,
  reset: () => set({ byScope: {} }),
}));
