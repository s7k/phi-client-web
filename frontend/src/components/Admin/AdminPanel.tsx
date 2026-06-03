/**
 * 管理画面(管理者限定)。アセット / 紐付け / ユーザ管理 をタブ切替で提供。
 *
 * 導線: キャラ選択画面(CharacterSelect)から isAdmin 時のみ開ける。
 * 閉じると uiStore.adminOpen=false でキャラ選択へ戻る。
 * 変更系は BE 側 require_admin で再検証されるため、FE フラグだけでは権限昇格しない。
 */
import { useState } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { AssetManager } from './AssetManager';
import { IndexEditor } from './IndexEditor';
import { UserManager } from './UserManager';
import './Admin.css';

type Tab = 'assets' | 'index' | 'users';

const TABS: { key: Tab; label: string }[] = [
  { key: 'assets', label: 'アセット' },
  { key: 'index', label: 'キャラ紐付け' },
  { key: 'users', label: 'ユーザ管理' },
];

export function AdminPanel() {
  const setAdminOpen = useUiStore((s) => s.setAdminOpen);
  const [tab, setTab] = useState<Tab>('assets');

  return (
    <div className="admin">
      <div className="admin__card">
        <header className="admin__header">
          <h1 className="admin__title">管理画面</h1>
          <button
            type="button"
            className="admin__close"
            onClick={() => setAdminOpen(false)}
          >
            閉じる
          </button>
        </header>

        <nav className="admin__tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`admin__tab${tab === t.key ? ' admin__tab--active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="admin__body">
          {tab === 'assets' && <AssetManager />}
          {tab === 'index' && <IndexEditor />}
          {tab === 'users' && <UserManager />}
        </div>
      </div>
    </div>
  );
}
