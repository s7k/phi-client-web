/**
 * App ルート。
 * - WsProvider で controller を供給。
 * - activeTab(uiStore) 未設定ならログイン/キャラ選択、設定済なら game画面。
 * - game画面: タブ(F9) + ステータス(F6) + マップ(F4) + チャット(F7)。
 *   リスト/編集ダイアログ(F9)とキーハンドラ(F8)を配線。
 */
import { WsProvider } from './ws/WsContext';
import type { WsController } from './ws/controller';
import { useUiStore } from './stores/uiStore';
import { useKeyHandler } from './lib/useKeyHandler';
import { Login } from './components/Login';
import { StatusPanel } from './components/StatusPanel';
import { Chat } from './components/Chat';
import { MapView } from './components/MapView';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TabBar } from './components/TabBar';
import { ListView } from './components/ListView';
import { EditDialog } from './components/EditDialog';
import './App.css';

function Game({
  controller,
  session,
}: {
  controller: WsController;
  session: string;
}) {
  // F8 キーハンドラ配線(アクティブ session 対象)
  useKeyHandler(controller, session);
  return (
    <div className="game">
      <aside className="game__side">
        <StatusPanel session={session} />
        <ListView session={session} />
      </aside>
      <main className="game__main">
        <MapView session={session} />
        <Chat session={session} />
      </main>
      <EditDialog session={session} />
    </div>
  );
}

export function App({ controller }: { controller: WsController }) {
  const activeTab = useUiStore((s) => s.activeTab);
  return (
    <WsProvider controller={controller}>
      {activeTab ? (
        <>
          <TabBar />
          <Game controller={controller} session={activeTab} />
        </>
      ) : (
        <Login />
      )}
      <ConfirmDialog />
    </WsProvider>
  );
}
