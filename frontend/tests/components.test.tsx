import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WsProvider } from '../src/ws/WsContext';
import type { WsController } from '../src/ws/controller';
import { Login } from '../src/components/Login';
import { StatusPanel } from '../src/components/StatusPanel';
import { Chat } from '../src/components/Chat';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { useSessionStore } from '../src/stores/sessionStore';
import { useStatusStore } from '../src/stores/statusStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUserStore } from '../src/stores/userStore';
import { useUiStore } from '../src/stores/uiStore';

/** controller の最小スタブ。 */
function makeController(over: Partial<WsController> = {}): WsController {
  return {
    auth: vi.fn(async () => []),
    openSession: vi.fn(async () => 's1'),
    sendChat: vi.fn(),
    ...over,
  } as unknown as WsController;
}

function renderWith(ctrl: WsController, ui: React.ReactElement) {
  return render(<WsProvider controller={ctrl}>{ui}</WsProvider>);
}

beforeEach(() => {
  useSessionStore.getState().reset();
  useStatusStore.getState().reset();
  useChatStore.getState().reset();
  useUserStore.getState().reset();
  useUiStore.getState().reset();
});

describe('Login (F3)', () => {
  it('ログイン→auth呼出→キャラ選択→openSession', async () => {
    const auth = vi.fn(async () => {
      useSessionStore.getState().setCharacters([{ charId: 'c1', name: 'A' }]);
      return [{ charId: 'c1', name: 'A' }];
    });
    const openSession = vi.fn(async () => 's1');
    const ctrl = makeController({ auth, openSession });
    renderWith(ctrl, <Login />);

    fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'u' } });
    fireEvent.change(screen.getByLabelText('パスワード'), {
      target: { value: 'p' },
    });
    fireEvent.click(screen.getByText('ログイン'));

    await waitFor(() => expect(auth).toHaveBeenCalledWith('u', 'p'));
    // キャラ選択フェーズ
    const charBtn = await screen.findByText('A');
    fireEvent.click(charBtn);
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('c1'));
    expect(useUiStore.getState().activeTab).toBe('s1');
  });

  it('auth失敗でエラー表示', async () => {
    const auth = vi.fn(async () => {
      throw new Error('認証失敗');
    });
    renderWith(makeController({ auth }), <Login />);
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'u' } });
    fireEvent.change(screen.getByLabelText('パスワード'), {
      target: { value: 'p' },
    });
    fireEvent.click(screen.getByText('ログイン'));
    expect(await screen.findByRole('alert')).toHaveTextContent('認証失敗');
  });
});

describe('StatusPanel (F6)', () => {
  it('HP/MP/状態異常を表示', () => {
    useStatusStore.getState().setStatus('s1', {
      type: 'status',
      session: 's1',
      name: 'Hero',
      hp: 30,
      maxHp: 100,
      mp: 5,
      maxMp: 10,
      exp: 7,
      gp: 9,
      f: 1,
      w: 2,
      m: 3,
      c: 4,
    });
    useStatusStore.getState().setCond('s1', {
      type: 'cond',
      session: 's1',
      poison: true,
      palsy: false,
      panic: false,
      confuse: false,
      berserk: false,
      silence: false,
      blind: false,
    });
    renderWith(makeController(), <StatusPanel session="s1" />);
    expect(screen.getByText('Hero')).toBeInTheDocument();
    expect(screen.getByText('30 / 100')).toBeInTheDocument();
    expect(screen.getByText('毒')).toBeInTheDocument();
  });
});

describe('Chat (F7)', () => {
  it('markupメッセージを色付き描画', () => {
    useChatStore.getState().addMessage('s1', {
      type: 'message',
      session: 's1',
      channel: 'log',
      text: '/*r*/赤/*.*/',
      markup: true,
    });
    const { container } = renderWith(makeController(), <Chat session="s1" />);
    const colored = container.querySelector('span[style*="color"]');
    expect(colored).not.toBeNull();
    expect(colored).toHaveTextContent('赤');
  });

  it('通常発言を sendChat 送信', () => {
    const sendChat = vi.fn();
    renderWith(makeController({ sendChat }), <Chat session="s1" />);
    fireEvent.change(screen.getByPlaceholderText('メッセージを入力'), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByText('送信'));
    expect(sendChat).toHaveBeenCalledWith('s1', 'normal', 'hello', undefined);
  });

  it('大声は確認ダイアログ経由(誤爆防止)', () => {
    const sendChat = vi.fn();
    renderWith(
      makeController({ sendChat }),
      <>
        <Chat session="s1" />
        <ConfirmDialog />
      </>,
    );
    fireEvent.click(screen.getByText('大声'));
    fireEvent.change(screen.getByPlaceholderText('メッセージを入力'), {
      target: { value: 'LOUD' },
    });
    fireEvent.click(screen.getByText('送信'));
    // 直送せずダイアログ
    expect(sendChat).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('OK'));
    expect(sendChat).toHaveBeenCalledWith('s1', 'loud', 'LOUD', undefined);
  });

  it('priv は宛先選択で送信', () => {
    const sendChat = vi.fn();
    useUserStore.getState().setUsers('s1', { users: [{ key: 'u1', name: 'Bob' }] });
    renderWith(makeController({ sendChat }), <Chat session="s1" />);
    fireEvent.click(screen.getByText('プライベート'));
    fireEvent.change(screen.getByLabelText('宛先'), { target: { value: 'u1' } });
    fireEvent.change(screen.getByPlaceholderText('メッセージを入力'), {
      target: { value: 'psst' },
    });
    fireEvent.click(screen.getByText('送信'));
    expect(sendChat).toHaveBeenCalledWith('s1', 'priv', 'psst', 'u1');
  });
});
