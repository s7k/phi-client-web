/**
 * settingsStore — scope別 設定([12]§3, §5)。
 * 更新元: settings(SQLite同期)。
 * scope: keybind / notify / display / intervals。値はBE/FE共通JSON。
 */
import { create } from 'zustand';
import type { SettingsScope } from '../types/protocol';

/** display scope の既定値([12]§3.3)。 */
export interface DisplaySettings {
  mapSize: 40 | 57;
  mapStyle: 'turn' | 'solid';
  eagleEye: boolean;
  fontScale: number;
  theme: 'dark' | 'light';
}

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
