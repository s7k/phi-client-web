/**
 * App ルート。
 * - WsProvider で controller を供給。
 * - activeTab(uiStore) 未設定ならログイン/キャラ選択、設定済なら game画面。
 * - game画面: ステータス(F6) + チャット(F7) の最小レイアウト。
 */
import { WsProvider } from './ws/WsContext';
import type { WsController } from './ws/controller';
import { useUiStore } from './stores/uiStore';
import { Login } from './components/Login';
import { StatusPanel } from './components/StatusPanel';
import { Chat } from './components/Chat';
import { ConfirmDialog } from './components/ConfirmDialog';
import './App.css';

function Game({ session }: { session: string }) {
  return (
    <div className="game">
      <aside className="game__side">
        <StatusPanel session={session} />
      </aside>
      <main className="game__main">
        <Chat session={session} />
      </main>
    </div>
  );
}

export function App({ controller }: { controller: WsController }) {
  const activeTab = useUiStore((s) => s.activeTab);
  return (
    <WsProvider controller={controller}>
      {activeTab ? <Game session={activeTab} /> : <Login />}
      <ConfirmDialog />
    </WsProvider>
  );
}
