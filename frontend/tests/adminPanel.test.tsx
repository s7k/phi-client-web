import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminPanel } from '../src/components/Admin/AdminPanel';
import { useUiStore } from '../src/stores/uiStore';
import { useAccountStore } from '../src/stores/accountStore';

beforeEach(() => {
  useUiStore.getState().reset();
  // fetch をスタブ(各タブの初期ロードを満たす)。
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body =
        url.includes('/api/admin/accounts')
          ? { accounts: [{ accountId: 'admin1', isAdmin: true, createdAt: 't', charCount: 0 }] }
          : url.includes('/api/chara/index')
            ? [{ key: '戦士', graName: 't_elf' }]
            : []; // graphics / chips は空配列
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
});

describe('AdminPanel', () => {
  it('タブ切替でアセット/紐付け/ユーザ管理を表示し、閉じるで adminOpen=false', async () => {
    useUiStore.getState().setAdminOpen(true);
    render(<AdminPanel />);

    // 既定はアセットタブ(キャラグラ/マップチップ切替が出る)。
    expect(screen.getByText('マップチップ')).toBeTruthy();

    // 紐付けタブ → datalist 補完の入力が出る。
    fireEvent.click(screen.getByRole('tab', { name: 'キャラ紐付け' }));
    await waitFor(() => expect(screen.getByText('登録 / 更新')).toBeTruthy());

    // ユーザ管理タブ → admin1 行が出る。
    fireEvent.click(screen.getByRole('tab', { name: 'ユーザ管理' }));
    await waitFor(() => expect(screen.getByText('admin1')).toBeTruthy());

    // 閉じる。
    fireEvent.click(screen.getByText('閉じる'));
    expect(useUiStore.getState().adminOpen).toBe(false);
  });
});

describe('accountStore', () => {
  it('setIsAdmin / reset で isAdmin を切替', () => {
    useAccountStore.getState().setIsAdmin(true);
    expect(useAccountStore.getState().isAdmin).toBe(true);
    useAccountStore.getState().reset();
    expect(useAccountStore.getState().isAdmin).toBe(false);
  });
});
