/**
 * accountStore — ログイン中アカウントの属性(管理者か否か)。
 *
 * login 応答の isAdmin を保持し、管理画面ボタンの出し分けに使う。
 * リロード復帰(token 自動ログイン)に備え localStorage にも併存させる。
 * 注: これは UI 出し分け用のヒントに過ぎず、変更系 API は BE 側 require_admin で
 * 再検証される(FE フラグ改ざんでは権限昇格できない)。
 */
import { create } from 'zustand';

const IS_ADMIN_KEY = 'phi_is_admin';

function readStored(): boolean {
  try {
    return globalThis.localStorage?.getItem(IS_ADMIN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStored(value: boolean): void {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    if (value) ls.setItem(IS_ADMIN_KEY, '1');
    else ls.removeItem(IS_ADMIN_KEY);
  } catch {
    /* localStorage 不可環境は無視 */
  }
}

interface AccountStoreState {
  isAdmin: boolean;
  setIsAdmin: (value: boolean) => void;
  reset: () => void;
}

export const useAccountStore = create<AccountStoreState>((set) => ({
  isAdmin: readStored(),
  setIsAdmin: (value) => {
    writeStored(value);
    set({ isAdmin: value });
  },
  reset: () => {
    writeStored(false);
    set({ isAdmin: false });
  },
}));
