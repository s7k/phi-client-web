/**
 * App ルート。
 * - WsProvider で controller を供給。
 * - activeTab(uiStore) 未設定ならログイン/キャラ選択、設定済なら game画面。
 * - game画面: タブ(F9) + ステータス(F6) + マップ(F4) + チャット(F7)。
 *   リスト/編集ダイアログ(F9)とキーハンドラ(F8)を配線。
 */
import { useRef } from 'react';
import { WsProvider } from './ws/WsContext';
import type { WsController } from './ws/controller';
import { useUiStore } from './stores/uiStore';
import { useSettingsStore } from './stores/settingsStore';
import type { DisplaySettings } from './stores/settingsStore';
import { useKeyHandler } from './lib/useKeyHandler';
import { captureCanvas } from './lib/screenshot';
import { Login } from './components/Login';
import { StatusPanel } from './components/StatusPanel';
import { Chat } from './components/Chat';
import { MapView } from './components/MapView';
import { EagleEyeView } from './components/EagleEyeView';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Settings } from './components/Settings';
import { TabBar } from './components/TabBar';
import { ListView } from './components/ListView';
import { EditDialog } from './components/EditDialog';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorBanners } from './components/ErrorBanners';
import { WorldTransferIndicator } from './components/WorldTransferIndicator';
import { WorldArea } from './components/WorldArea';
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
  const mainRef = useRef<HTMLElement>(null);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const eagleEye =
    useSettingsStore((s) => (s.byScope['display'] as DisplaySettings | undefined)?.eagleEye) ??
    false;

  // F11 スクリーンショット: マップ(or EagleEye)Canvas を PNG ダウンロード([05]§12)。
  function takeScreenshot() {
    const canvas = mainRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
    if (canvas) void captureCanvas(canvas);
  }

  return (
    <div className="game">
      <aside className="game__side">
        <StatusPanel session={session} />
        <ListView session={session} />
      </aside>
      <main className="game__main" ref={mainRef}>
        <div className="game__toolbar">
          <WorldArea session={session} />
          <button type="button" onClick={() => setSettingsOpen(true)}>
            設定
          </button>
          <button type="button" onClick={takeScreenshot}>
            スクリーンショット
          </button>
          <button type="button" onClick={() => void controller.logout()}>
            ログアウト
          </button>
        </div>
        <WorldTransferIndicator />
        {eagleEye ? <EagleEyeView session={session} /> : <MapView session={session} />}
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
      <ConnectionBanner />
      <ErrorBanners />
      {activeTab ? (
        <>
          <TabBar />
          <Game controller={controller} session={activeTab} />
        </>
      ) : (
        <Login />
      )}
      <ConfirmDialog />
      <Settings />
    </WsProvider>
  );
}
