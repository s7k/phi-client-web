/**
 * useTheme — display.theme(dark/light)を DOM へ適用([12]§3.3)。
 *
 * settingsStore の display.theme 変更を購読し、
 *   - documentElement.dataset.theme = 'light' | 'dark'(既定 dark)
 *   - color-scheme をテーマ連動
 *   - fontScale を documentElement.style.fontSize へ反映(任意)
 * を適用。CSS変数(App.css の :root / :root[data-theme="light"])が
 * この data 属性で切替わる。
 */
import { useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { DEFAULT_DISPLAY, type DisplaySettings } from '../stores/settingsStore';

/** display 設定を documentElement へ適用(テスト用に純関数として公開)。 */
export function applyTheme(display: Partial<DisplaySettings> | undefined): void {
  if (typeof document === 'undefined') return;
  const theme = display?.theme ?? DEFAULT_DISPLAY.theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const scale = display?.fontScale ?? DEFAULT_DISPLAY.fontScale;
  // 16px(ブラウザ既定 rem)基準に倍率反映。rem ベースの全 UI が連動。
  root.style.fontSize = `${16 * scale}px`;
}

/** display.theme/fontScale を購読し DOM へ適用する effect フック。 */
export function useTheme(): void {
  const display = useSettingsStore(
    (s) => s.byScope['display'] as DisplaySettings | undefined,
  );
  useEffect(() => {
    applyTheme(display);
  }, [display]);
}
