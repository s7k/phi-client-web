import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { describeKeys } from '../src/lib/keyHandler';
import { HelpDialog } from '../src/components/HelpDialog';
import { useUiStore } from '../src/stores/uiStore';

const base = { magic: {}, shortcuts: {}, altG: '' };

describe('describeKeys', () => {
  it('北固定の仮想テンキーでは 8 が北へ、U が西へ', () => {
    const move = describeKeys({ ...base, layout: 'numpad', northFix: true })[0];
    expect(move.rows).toContainEqual({ keys: '8', action: '北へ' });
    expect(move.rows).toContainEqual({ keys: 'U', action: '西へ' });
  });

  it('回転マップでは 8 が前へ、← が左を向く', () => {
    const move = describeKeys({ ...base, layout: 'numpad', northFix: false })[0];
    expect(move.rows).toContainEqual({ keys: '8', action: '前へ' });
    expect(move.rows).toContainEqual({ keys: '←', action: '左を向く' });
  });

  it('割り当てた Shift+数字と Shift+G だけ出す', () => {
    const groups = describeKeys({
      layout: 'wasd', northFix: true,
      magic: { F1: 'Cure', F2: null }, shortcuts: { F10: 'check\nlook' }, altG: 'おやすみ',
    });
    const fn = groups.find((g) => g.title.startsWith('魔法・ショートカット'))!;
    expect(fn.rows).toEqual([
      { keys: 'Shift+1', action: 'Cure を唱える' },
      { keys: 'Shift+0', action: 'check ↵ look を送る' },
      { keys: 'Shift+G', action: 'おやすみ を送る' },
    ]);
  });
});

describe('HelpDialog', () => {
  beforeEach(() => useUiStore.getState().reset());

  it('開くと一覧を出し、Esc で閉じる', () => {
    useUiStore.getState().setHelpOpen(true);
    const { getByRole, queryByRole } = render(<HelpDialog session="s1" />);
    expect(getByRole('dialog', { name: 'キー操作' })).toHaveTextContent('リスト表示中');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
  });
});
