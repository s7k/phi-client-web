/**
 * App ルート(A-34, アカウント+複数キャラ構造)。
 * - WsProvider で controller を供給。
 * - 画面遷移:
 *   - 未ログイン(token 無し) → Login(アカウントID+パスワード)。
 *   - ログイン済 + activeTab 無し → CharacterSelect(一覧/追加/削除)。
 *   - ログイン済 + activeTab あり → Game画面。
 * - 起動時 token あれば自動ログイン状態でキャラ選択画面へ。
 * - game画面: タブ(F9) + ステータス(F6) + マップ(F4) + チャット(F7)。
 *   リスト/編集ダイアログ(F9)とキーハンドラ(F8)を配線。
 */
import { useEffect, useRef, useState } from 'react';
import { WsProvider } from './ws/WsContext';
import type { WsController } from './ws/controller';
import { useUiStore } from './stores/uiStore';
import { useSettingsStore } from './stores/settingsStore';
import type { DisplaySettings, KeybindSettings } from './stores/settingsStore';
import { useKeyHandler } from './lib/useKeyHandler';
import { useTheme } from './lib/useTheme';
import { captureCanvas } from './lib/screenshot';
import { getStoredToken } from './api/auth';
import { Login } from './components/Login';
import { CharacterSelect } from './components/CharacterSelect';
import { StatusPanel } from './components/StatusPanel';
import { Chat } from './components/Chat';
import { MapView } from './components/MapView';
import { EagleEyeView } from './components/EagleEyeView';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Settings } from './components/Settings';
import { TabBar } from './components/TabBar';
import { ListView } from './components/ListView';
import { EditDialog } from './components/EditDialog';
import { TouchControls } from './components/TouchControls';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ErrorBanners } from './components/ErrorBanners';
import { WorldTransferIndicator } from './components/WorldTransferIndicator';
import { WorldArea } from './components/WorldArea';
import './App.css';

function Game({
  controller,
  session,
  onLogout,
}: {
  controller: WsController;
  session: string;
  onLogout: () => void;
}) {
  // F8 キーハンドラ配線(アクティブ session 対象)
  useKeyHandler(controller, session);
  const mainRef = useRef<HTMLElement>(null);
  // モバイルでは普段使わない操作(設定/SS/ログアウト)をハンバーガーに集約。
  const [menuOpen, setMenuOpen] = useState(false);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const eagleEye =
    useSettingsStore((s) => (s.byScope['display'] as DisplaySettings | undefined)?.eagleEye) ??
    false;
  // タッチ操作パッドの利き手(スマホ)。マップをパッドの逆側へ寄せ重なりを回避。
  const touchHand =
    useSettingsStore((s) => (s.byScope['keybind'] as KeybindSettings | undefined)?.touchHand) ??
    'right';

  // F11 スクリーンショット: マップ(or EagleEye)Canvas を PNG ダウンロード([05]§12)。
  function takeScreenshot() {
    const canvas = mainRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
    if (canvas) void captureCanvas(canvas);
  }

  return (
    <div className="game">
      {/* 上部バー: 世界/エリア + 操作ボタン */}
      <header className="game__topbar">
        <WorldArea session={session} />
        {/* モバイル用ハンバーガー(デスクトップはCSSで非表示) */}
        <button
          type="button"
          className="game__hamburger"
          aria-label="メニュー"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ☰
        </button>
        <div className={`game__actions${menuOpen ? ' game__actions--open' : ''}`}>
          <button type="button" onClick={() => { setSettingsOpen(true); setMenuOpen(false); }}>設定</button>
          <button type="button" onClick={() => { takeScreenshot(); setMenuOpen(false); }}>SS</button>
          <button
            type="button"
            onClick={() => { setMenuOpen(false); void controller.logout().then(onLogout); }}
          >
            ログアウト
          </button>
        </div>
      </header>
      <WorldTransferIndicator />
      {/* 本体: デスクトップ=左(マップ+ステータス)/右(チャット)。
          モバイル=チャット(ログ+入力)上→マップ→ステータス下 */}
      <div className="game__body">
        <section className={`game__map game__map--pad-${touchHand}`} ref={mainRef}>
          {eagleEye ? <EagleEyeView session={session} /> : <MapView session={session} />}
          {/* スマホのみ表示の操作パッド(CSS で desktop は非表示)。 */}
          <TouchControls session={session} />
        </section>
        <section className="game__chat">
          <Chat session={session} />
        </section>
        <section className="game__status">
          <StatusPanel session={session} />
          <ListView session={session} />
        </section>
      </div>
      <EditDialog session={session} />
    </div>
  );
}

export function App({ controller }: { controller: WsController }) {
  // display.theme/fontScale を documentElement へ適用(ライト/ダーク切替)。
  useTheme();
  const activeTab = useUiStore((s) => s.activeTab);
  // 起動時 token があればログイン済(自動復帰)→キャラ選択画面へ(A-34)。
  const [loggedIn, setLoggedIn] = useState(() => getStoredToken() !== null);

  // ログイン後すぐ全設定を先読み(theme/fontScale を起動時に適用。設定画面を
  // 開くまでライトテーマが反映されなかった件の対策)。
  useEffect(() => {
    if (!loggedIn) return;
    void controller.preloadSettings();
  }, [loggedIn, controller]);

  let screen: React.ReactNode;
  if (!loggedIn) {
    screen = <Login onLoggedIn={() => setLoggedIn(true)} />;
  } else if (activeTab) {
    screen = (
      <>
        <TabBar />
        <Game
          controller={controller}
          session={activeTab}
          onLogout={() => setLoggedIn(false)}
        />
      </>
    );
  } else {
    screen = <CharacterSelect onLoggedOut={() => setLoggedIn(false)} />;
  }

  return (
    <WsProvider controller={controller}>
      {/* 100dvh のフレックス列。バナー/タブ(固定高)+本体(flex:1)を内包し
          ページ全体のスクロールを防ぐ(タブが100vh外に出てスクロールしていた件)。 */}
      <div className="app">
        <ConnectionBanner />
        <ErrorBanners />
        {screen}
      </div>
      <ConfirmDialog />
      <Settings />
    </WsProvider>
  );
}
