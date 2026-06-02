import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { applyTheme, useTheme } from '../src/lib/useTheme';
import { useSettingsStore } from '../src/stores/settingsStore';
import type { DisplaySettings } from '../src/stores/settingsStore';

beforeEach(() => {
  useSettingsStore.getState().reset();
  // 既定 dark を仮定しテスト間で初期化。
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  document.documentElement.style.fontSize = '';
});

describe('applyTheme(純関数)', () => {
  it('display 未設定は既定 dark を適用', () => {
    applyTheme(undefined);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('theme=light で data-theme/color-scheme が light', () => {
    applyTheme({ theme: 'light' } as DisplaySettings);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('fontScale を fontSize へ反映(16px基準)', () => {
    applyTheme({ theme: 'dark', fontScale: 1.5 } as DisplaySettings);
    expect(document.documentElement.style.fontSize).toBe('24px');
  });
});

/** useTheme を発火させるためのラッパ。 */
function ThemeHost() {
  useTheme();
  return null;
}

describe('useTheme(effect)', () => {
  it('display.theme 変更で documentElement の data-theme が切替わる', () => {
    // 初期 dark
    useSettingsStore
      .getState()
      .setScope('display', { theme: 'dark', fontScale: 1.0 });
    render(<ThemeHost />);
    expect(document.documentElement.dataset.theme).toBe('dark');

    // light へ変更 → effect 再実行で切替(act で再レンダ/effect 反映)
    act(() => {
      useSettingsStore
        .getState()
        .setScope('display', { theme: 'light', fontScale: 1.0 });
    });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('display 未配線(undefined)時は既定 dark', () => {
    render(<ThemeHost />);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
