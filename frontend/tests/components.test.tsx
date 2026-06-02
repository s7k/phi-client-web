import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WsProvider } from '../src/ws/WsContext';
import type { WsController } from '../src/ws/controller';
import { Login } from '../src/components/Login';
import { CharacterSelect } from '../src/components/CharacterSelect';
import type { Character } from '../src/api/characters';
import { StatusPanel } from '../src/components/StatusPanel';
import { Chat } from '../src/components/Chat';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { ListView } from '../src/components/ListView';
import { EditDialog } from '../src/components/EditDialog';
import { TabBar } from '../src/components/TabBar';
import { useSessionStore } from '../src/stores/sessionStore';
import { useStatusStore } from '../src/stores/statusStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUserStore } from '../src/stores/userStore';
import { useUiStore } from '../src/stores/uiStore';
import { useListStore } from '../src/stores/listStore';
import { useEditStore } from '../src/stores/editStore';
import { useConnectionStore } from '../src/stores/connectionStore';

/** controller の最小スタブ。 */
function makeController(over: Partial<WsController> = {}): WsController {
  return {
    login: vi.fn(async () => ({ ok: true, isAdmin: false, token: 'tk-test' })),
    register: vi.fn(async () => ({ ok: true })),
    fetchCharacters: vi.fn(async () => []),
    addCharacter: vi.fn(async () => null),
    removeCharacter: vi.fn(async () => undefined),
    openSession: vi.fn(async () => 's1'),
    logout: vi.fn(async () => undefined),
    sendChat: vi.fn(),
    sendMove: vi.fn(),
    sendCommand: vi.fn(),
    sendListSelect: vi.fn(),
    submitEdit: vi.fn(),
    cancelEdit: vi.fn(),
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
  useListStore.getState().reset();
  useEditStore.getState().reset();
  useConnectionStore.getState().reset();
  localStorage.clear();  // ログインフォーム記憶等がテスト間で漏れないように
});

describe('Login (A-34, アカウント+パスワード)', () => {
  it('アカウントID+パスワード入力→login→onLoggedIn', async () => {
    const login = vi.fn(async () => ({ ok: true as const, isAdmin: false, token: 'tk-test' }));
    const onLoggedIn = vi.fn();
    const ctrl = makeController({ login });
    renderWith(ctrl, <Login onLoggedIn={onLoggedIn} />);

    fireEvent.change(screen.getByLabelText('アカウントID'), { target: { value: 'acc-1' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByText('ログイン'));

    await waitFor(() => expect(login).toHaveBeenCalledWith('acc-1', 'pw'));
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalled());
  });

  it('アカウントID 未入力ではログイン不可(エラー表示)', async () => {
    const login = vi.fn(async () => ({ ok: true as const, isAdmin: false, token: 'tk-test' }));
    renderWith(makeController({ login }), <Login onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByText('ログイン'));
    expect(await screen.findByRole('alert')).toHaveTextContent('アカウントID');
    expect(login).not.toHaveBeenCalled();
  });

  it('ログイン失敗でエラー表示', async () => {
    const login = vi.fn(async () => {
      throw new Error('認証失敗');
    });
    renderWith(makeController({ login }), <Login onLoggedIn={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('アカウントID'), { target: { value: 'acc-x' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByText('ログイン'));
    expect(await screen.findByRole('alert')).toHaveTextContent('認証失敗');
  });

  it('新規登録: ID+パスワード+確認→register→ログイン画面へ案内', async () => {
    const register = vi.fn(async () => ({ ok: true as const }));
    renderWith(makeController({ register }), <Login onLoggedIn={vi.fn()} />);
    fireEvent.click(screen.getByText('新規登録'));
    fireEvent.change(screen.getByLabelText('アカウントID'), { target: { value: 'new-acc' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('パスワード(確認)'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByText('登録'));
    await waitFor(() => expect(register).toHaveBeenCalledWith('new-acc', 'secret'));
    // ログイン画面へ戻り案内表示
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('登録'));
  });

  it('新規登録: パスワード不一致でエラー(register未呼)', async () => {
    const register = vi.fn(async () => ({ ok: true as const }));
    renderWith(makeController({ register }), <Login onLoggedIn={vi.fn()} />);
    fireEvent.click(screen.getByText('新規登録'));
    fireEvent.change(screen.getByLabelText('アカウントID'), { target: { value: 'new-acc' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('パスワード(確認)'), { target: { value: 'other' } });
    fireEvent.click(screen.getByText('登録'));
    expect(await screen.findByRole('alert')).toHaveTextContent('一致');
    expect(register).not.toHaveBeenCalled();
  });

  it('新規登録: 409(既存)でエラー表示', async () => {
    const register = vi.fn(async () => {
      throw new Error('このアカウントIDは既に使用されています');
    });
    renderWith(makeController({ register }), <Login onLoggedIn={vi.fn()} />);
    fireEvent.click(screen.getByText('新規登録'));
    fireEvent.change(screen.getByLabelText('アカウントID'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('パスワード(確認)'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByText('登録'));
    expect(await screen.findByRole('alert')).toHaveTextContent('既に使用');
  });
});

describe('CharacterSelect (A-34)', () => {
  const chars: Character[] = [
    { charId: 'c1', label: 'Hero', host: '10.0.0.1', port: 20000 },
    { charId: 'c2', label: 'Mage', host: '10.0.0.2', port: 21000 },
  ];

  it('一覧をラベル+host:port で表示', async () => {
    const fetchCharacters = vi.fn(async () => chars);
    renderWith(makeController({ fetchCharacters }), <CharacterSelect onLoggedOut={vi.fn()} />);
    expect(await screen.findByText('Hero')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.1:20000')).toBeInTheDocument();
    expect(screen.getByText('Mage')).toBeInTheDocument();
  });

  it('キャラクリックで openSession(charId)→activeTab', async () => {
    const fetchCharacters = vi.fn(async () => chars);
    const openSession = vi.fn(async () => 's5');
    renderWith(
      makeController({ fetchCharacters, openSession }),
      <CharacterSelect onLoggedOut={vi.fn()} />,
    );
    fireEvent.click(await screen.findByText('Hero'));
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('c1', 'Hero'));
    expect(useUiStore.getState().activeTab).toBe('s5');
  });

  it('追加フォーム: ラベル+PHI ID+IP+ポート→addCharacter→一覧再取得', async () => {
    const fetchCharacters = vi.fn(async () => []);
    const addCharacter = vi.fn(async () => null);
    renderWith(
      makeController({ fetchCharacters, addCharacter }),
      <CharacterSelect onLoggedOut={vi.fn()} />,
    );
    await waitFor(() => expect(fetchCharacters).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('ラベル'), { target: { value: 'Cleric' } });
    fireEvent.change(screen.getByLabelText('PHI ID'), { target: { value: 'PHI999' } });
    fireEvent.change(screen.getByLabelText('サーバIP'), { target: { value: '10.0.0.3' } });
    fireEvent.change(screen.getByLabelText('ポート'), { target: { value: '22000' } });
    fireEvent.click(screen.getByText('追加'));
    await waitFor(() =>
      expect(addCharacter).toHaveBeenCalledWith({
        label: 'Cleric',
        phiId: 'PHI999',
        host: '10.0.0.3',
        port: 22000,
      }),
    );
    await waitFor(() => expect(fetchCharacters).toHaveBeenCalledTimes(2));
  });

  it('追加フォーム: ポート範囲外でエラー(addCharacter未呼)', async () => {
    const addCharacter = vi.fn(async () => null);
    renderWith(
      makeController({ fetchCharacters: vi.fn(async () => []), addCharacter }),
      <CharacterSelect onLoggedOut={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('ラベル'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('PHI ID'), { target: { value: 'P' } });
    fireEvent.change(screen.getByLabelText('サーバIP'), { target: { value: 'h' } });
    fireEvent.change(screen.getByLabelText('ポート'), { target: { value: '70000' } });
    fireEvent.click(screen.getByText('追加'));
    expect(await screen.findByRole('alert')).toHaveTextContent('ポート');
    expect(addCharacter).not.toHaveBeenCalled();
  });

  it('削除ボタンで removeCharacter→一覧再取得', async () => {
    const fetchCharacters = vi.fn(async () => chars);
    const removeCharacter = vi.fn(async () => undefined);
    renderWith(
      makeController({ fetchCharacters, removeCharacter }),
      <CharacterSelect onLoggedOut={vi.fn()} />,
    );
    fireEvent.click(await screen.findByLabelText('Hero を削除'));
    await waitFor(() => expect(removeCharacter).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(fetchCharacters).toHaveBeenCalledTimes(2));
  });

  it('ログアウトボタンで logout→onLoggedOut', async () => {
    const logout = vi.fn(async () => undefined);
    const onLoggedOut = vi.fn();
    renderWith(
      makeController({ fetchCharacters: vi.fn(async () => []), logout }),
      <CharacterSelect onLoggedOut={onLoggedOut} />,
    );
    fireEvent.click(screen.getByText('ログアウト'));
    await waitFor(() => expect(logout).toHaveBeenCalled());
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
  });

  it('一覧取得失敗でエラー表示', async () => {
    const fetchCharacters = vi.fn(async () => {
      throw new Error('取得失敗');
    });
    renderWith(makeController({ fetchCharacters }), <CharacterSelect onLoggedOut={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('取得失敗');
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

describe('ListView (F9)', () => {
  it('非activeなら非表示', () => {
    useListStore.getState().setList('s1', { active: false });
    const { container } = renderWith(makeController(), <ListView session="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it('項目を番号付き表示・クリックで list.select(数値)', () => {
    const sendListSelect = vi.fn();
    useListStore.getState().setList('s1', {
      active: true,
      lines: ['1: 短剣', '2: 鉄の剣'],
    });
    renderWith(makeController({ sendListSelect }), <ListView session="s1" />);
    expect(screen.getByText('短剣')).toBeInTheDocument();
    fireEvent.click(screen.getByText('鉄の剣'));
    expect(sendListSelect).toHaveBeenCalledWith('s1', 2);
  });

  it('全選択(+)・キャンセル', () => {
    const sendListSelect = vi.fn();
    useListStore.getState().setList('s1', { active: true, lines: ['1: x'] });
    renderWith(makeController({ sendListSelect }), <ListView session="s1" />);
    fireEvent.click(screen.getByText('全選択 (+)'));
    expect(sendListSelect).toHaveBeenCalledWith('s1', 'all');
    fireEvent.click(screen.getByText('キャンセル (Esc)'));
    expect(sendListSelect).toHaveBeenCalledWith('s1', 'cancel');
  });
});

describe('EditDialog (F9)', () => {
  it('非activeなら非表示', () => {
    const { container } = renderWith(
      makeController(),
      <EditDialog session="s1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('multi: 複数行を改行分割して submitEdit', () => {
    const submitEdit = vi.fn();
    useEditStore.getState().setEdit('s1', { mode: 'multi' });
    renderWith(makeController({ submitEdit }), <EditDialog session="s1" />);
    fireEvent.change(screen.getByLabelText('入力本文'), {
      target: { value: 'line1\nline2\n' },
    });
    fireEvent.click(screen.getByText('確定 (Ctrl+Enter)'));
    expect(submitEdit).toHaveBeenCalledWith('s1', 'multi', ['line1', 'line2']);
  });

  it('キャンセルで cancelEdit', () => {
    const cancelEdit = vi.fn();
    useEditStore.getState().setEdit('s1', { mode: 'multi' });
    renderWith(makeController({ cancelEdit }), <EditDialog session="s1" />);
    fireEvent.click(screen.getByText('キャンセル'));
    expect(cancelEdit).toHaveBeenCalledWith('s1');
  });

  it('キャンセルで BE 応答を待たず即クローズ(editStore 非アクティブ化)', () => {
    useEditStore.getState().setEdit('s1', { mode: 'multi' });
    const { container } = renderWith(
      makeController({ cancelEdit: vi.fn() }),
      <EditDialog session="s1" />,
    );
    // 表示中
    expect(container.querySelector('.editdialog')).not.toBeNull();
    fireEvent.click(screen.getByText('キャンセル'));
    // edit end を待たず即座に閉じる
    expect(useEditStore.getState().bySession['s1'].active).toBe(false);
    expect(container.querySelector('.editdialog')).toBeNull();
  });

  it('Esc で即クローズ', () => {
    const cancelEdit = vi.fn();
    useEditStore.getState().setEdit('s1', { mode: 'multi' });
    renderWith(makeController({ cancelEdit }), <EditDialog session="s1" />);
    fireEvent.keyDown(screen.getByLabelText('入力本文'), { key: 'Escape' });
    expect(cancelEdit).toHaveBeenCalledWith('s1');
    expect(useEditStore.getState().bySession['s1'].active).toBe(false);
  });

  it('確定で即クローズ', () => {
    useEditStore.getState().setEdit('s1', { mode: 'multi' });
    renderWith(makeController({ submitEdit: vi.fn() }), <EditDialog session="s1" />);
    fireEvent.change(screen.getByLabelText('入力本文'), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByText('確定 (Ctrl+Enter)'));
    expect(useEditStore.getState().bySession['s1'].active).toBe(false);
  });
});

describe('TabBar (F9)', () => {
  it('session無しなら非表示', () => {
    const { container } = renderWith(makeController(), <TabBar />);
    expect(container.firstChild).toBeNull();
  });

  it('複数session切替・接続マーク・未読バッジ', () => {
    useSessionStore.getState().addSession({ session: 's1', label: 'Alice', opener: { charId: 'c1' } });
    useSessionStore.getState().addSession({ session: 's2', label: 'Bob', opener: { charId: 'c2' } });
    useConnectionStore.getState().setSessionConnection('s1', 'connected');
    useConnectionStore.getState().setSessionConnection('s2', 'closed');
    // 未読はチャット種別(talk/priv/loud)のみカウント。talk=プレイヤー発言。
    useChatStore.getState().addMessage('s2', {
      type: 'message',
      session: 's2',
      channel: 'talk',
      from: 'Carol',
      text: 'hi',
    });
    useUiStore.getState().setActiveTab('s1');

    renderWith(makeController(), <TabBar />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // s2 未読 1
    expect(screen.getByText('1')).toBeInTheDocument();
    // s2 接続マーク(closed)
    expect(screen.getByLabelText('切断')).toBeInTheDocument();

    // タブ切替
    fireEvent.click(screen.getByText('Bob'));
    expect(useUiStore.getState().activeTab).toBe('s2');
    expect(useSessionStore.getState().active).toBe('s2');
    // 未読クリア
    expect(useChatStore.getState().unread['s2']).toBe(0);
  });
});

describe('Login: アカウントID 記憶(localStorage, パスワードは保存しない)', () => {
  it('保存済みアカウントID でプリフィルし、ログイン成功で保存', async () => {
    localStorage.setItem('phi_login_account', 'SAVED_ACC');
    const login = vi.fn(async () => ({ ok: true as const, isAdmin: false, token: 'tk-test' }));
    renderWith(makeController({ login }), <Login onLoggedIn={vi.fn()} />);
    // プリフィル
    expect((screen.getByLabelText('アカウントID') as HTMLInputElement).value).toBe('SAVED_ACC');

    fireEvent.change(screen.getByLabelText('アカウントID'), { target: { value: 'NEW_ACC' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByText('ログイン'));
    await waitFor(() => expect(login).toHaveBeenCalledWith('NEW_ACC', 'pw'));
    // accountId のみ保存、password は保存しない
    expect(localStorage.getItem('phi_login_account')).toBe('NEW_ACC');
    expect(localStorage.getItem('phi_login_form')).toBeNull();
  });
});

describe('EditDialog は m-edit(複数行)のみ表示', () => {
  it('single(#s-edit)はモーダルを出さない(通常入力欄で応答)', () => {
    useEditStore.getState().setEdit('s1', { mode: 'single' } as any);
    const { container } = renderWith(makeController(), <EditDialog session="s1" />);
    expect(container.querySelector('.editdialog')).toBeNull();
  });
  it('multi(#m-edit)はモーダルを表示', () => {
    useEditStore.getState().setEdit('s1', { mode: 'multi' } as any);
    const { container } = renderWith(makeController(), <EditDialog session="s1" />);
    expect(container.querySelector('.editdialog')).not.toBeNull();
  });
});

