import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WsClient } from '../src/ws/client';
import { WsController, isSelfEcho, selfNameOf } from '../src/ws/controller';
import { useSessionStore } from '../src/stores/sessionStore';
import { useStatusStore } from '../src/stores/statusStore';
import { useChatStore } from '../src/stores/chatStore';
import { useConnectionStore } from '../src/stores/connectionStore';
import { useNoticeStore } from '../src/stores/noticeStore';
import { useUiStore } from '../src/stores/uiStore';
import { clearStoredToken, getStoredToken, setStoredToken } from '../src/api/auth';
import type { ServerMessage } from '../src/types/protocol';

/** open即時・reqId応答を制御可能な mock WS。 */
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static last: MockWebSocket | null = null;

  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(_url: string) {
    MockWebSocket.last = this;
    // 同期 open
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({});
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }
  emit(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function setup() {
  const client = new WsClient('ws://test/ws', {
    WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    autoReconnect: false,
  });
  const controller = new WsController(client);
  client.connect();
  return { client, controller };
}

/** establishSession の REST 呼び出しを成功スタブ化(A-33: token 発行を模す)。 */
function stubAuthFetch(isAdmin = false, label?: string, token = 'tk-test') {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, isAdmin, token, label }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  useSessionStore.getState().reset();
  useStatusStore.getState().reset();
  useChatStore.getState().reset();
  useConnectionStore.getState().reset();
  useNoticeStore.getState().reset();
  useUiStore.getState().reset();
  MockWebSocket.last = null;
  clearStoredToken();
  stubAuthFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WsController.establishSession (ID-only, REST, A-33 token)', () => {
  it('POST /api/auth/session で token 取得・localStorage保存し isAdmin を返す', async () => {
    stubAuthFetch(true, 'Admin', 'tk-1');
    const { controller, client } = setup();
    await Promise.resolve();
    const res = await controller.establishSession('phi-1');
    expect(res.ok).toBe(true);
    expect(res.isAdmin).toBe(true);
    expect(res.label).toBe('Admin');
    expect(res.token).toBe('tk-1');
    // token を localStorage 保存
    expect(getStoredToken()).toBe('tk-1');
    // client の WS auth ゲートが有効化(open 済なら auth 送信)
    expect(client.isOpen()).toBe(true);
    const sent = MockWebSocket.last!.sent.map((d) => JSON.parse(d));
    const authMsg = sent.find((m) => m.type === 'auth');
    expect(authMsg).toBeDefined();
    expect(authMsg.token).toBe('tk-1');
    // REST に id が送られる(password なし)
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(call[0]).toBe('/api/auth/session');
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.id).toBe('phi-1');
    expect('password' in body).toBe(false);
  });

  it('remember 指定で body.remember=true を送る', async () => {
    const { controller } = setup();
    await Promise.resolve();
    await controller.establishSession('phi-1', { remember: true });
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.remember).toBe(true);
  });

  it('REST 失敗で reject', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'AUTH_FAILED', message: '不正なID' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const { controller } = setup();
    await Promise.resolve();
    await expect(controller.establishSession('bad')).rejects.toThrow('不正なID');
  });
});

describe('WsController.fetchSavedList', () => {
  it('saved.list 応答の items を sessionStore へ格納', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    const p = controller.fetchSavedList();
    const req = ws.lastSent();
    expect(req.type).toBe('saved.list');
    expect(typeof req.reqId).toBe('string');
    ws.emit({
      type: 'saved.list',
      reqId: req.reqId as string,
      ok: true,
      items: [{ ref: 'r1', label: 'A', isAdmin: false }],
    } as ServerMessage);
    const items = await p;
    expect(items).toHaveLength(1);
    expect(useSessionStore.getState().saved[0].label).toBe('A');
    expect(useSessionStore.getState().saved[0].ref).toBe('r1');
  });
});

describe('WsController.openSession (id|ref)', () => {
  it('id 指定: 応答の session を登録・アクティブ化', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    const p = controller.openSession(
      { id: 'phi-1', host: '10.0.0.5', port: 30000, remember: true },
      'Hero',
    );
    const req = ws.lastSent();
    expect(req.type).toBe('session.open');
    expect(req.id).toBe('phi-1');
    expect(req.host).toBe('10.0.0.5');
    expect(req.port).toBe(30000);
    expect(req.remember).toBe(true);
    ws.emit({ type: 'session.open', session: 's1', reqId: req.reqId as string, ok: true, isAdmin: true } as ServerMessage);
    const session = await p;
    expect(session).toBe('s1');
    expect(useSessionStore.getState().active).toBe('s1');
    expect(useSessionStore.getState().sessions['s1'].label).toBe('Hero');
    expect(useSessionStore.getState().sessions['s1'].opener.id).toBe('phi-1');
    expect(useSessionStore.getState().sessions['s1'].opener.host).toBe('10.0.0.5');
    expect(useSessionStore.getState().sessions['s1'].opener.port).toBe(30000);
    expect(useSessionStore.getState().sessions['s1'].host).toBe('10.0.0.5');
    expect(useSessionStore.getState().sessions['s1'].port).toBe(30000);
    expect(useSessionStore.getState().sessions['s1'].isAdmin).toBe(true);
  });

  it('ref 指定: ref を送り opener.ref を保持', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    const p = controller.openSession({ ref: 'r1' }, 'Saved');
    const req = ws.lastSent();
    expect(req.ref).toBe('r1');
    expect('id' in req).toBe(false);
    ws.emit({ type: 'snapshot', session: 's2', reqId: req.reqId as string } as ServerMessage);
    await p;
    expect(useSessionStore.getState().sessions['s2'].opener.ref).toBe('r1');
  });

  it('id も ref も無いと throw', async () => {
    const { controller } = setup();
    await Promise.resolve();
    await expect(controller.openSession({})).rejects.toThrow();
  });
});

describe('WsController イベント配線', () => {
  it('status/message を store へ反映(session付与)', async () => {
    setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.emit({
      type: 'status',
      session: 's1',
      name: 'X',
      hp: 50,
      maxHp: 100,
      mp: 0,
      maxMp: 0,
      exp: 0,
      gp: 0,
      f: 0,
      w: 0,
      m: 0,
      c: 0,
    });
    expect(useStatusStore.getState().bySession['s1'].status?.hp).toBe(50);

    ws.emit({ type: 'message', session: 's1', channel: 'log', text: 'hi' });
    expect(useChatStore.getState().bySession['s1'][0].text).toBe('hi');
  });

  it('session欠落時はアクティブsessionで補完(A-03)', async () => {
    setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    useSessionStore.getState().addSession({ session: 's1', label: 'A', opener: { id: 'phi-1' } });
    useSessionStore.getState().setActive('s1');
    ws.emit({ type: 'message', channel: 'log', text: 'noSession' } as ServerMessage);
    expect(useChatStore.getState().bySession['s1'][0].text).toBe('noSession');
  });
});

describe('WsController.sendChat', () => {
  it('priv は to 必須', async () => {
    const { controller } = setup();
    await Promise.resolve();
    expect(() => controller.sendChat('s1', 'priv', 'x')).toThrow();
    controller.sendChat('s1', 'priv', 'x', 'u1');
    const sent = MockWebSocket.last!.lastSent();
    expect(sent.mode).toBe('priv');
    expect(sent.to).toBe('u1');
  });

  it('all は全アクティブsessionへ同報(ループ送信, A-08/14)', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    useSessionStore.getState().addSession({ session: 's1', label: 'A', opener: { id: 'phi-1' } });
    useSessionStore.getState().addSession({ session: 's2', label: 'B', opener: { id: 'phi-2' } });
    ws.sent = [];
    controller.sendChat('s1', 'all', 'hi');
    const sent = ws.sent.map((d) => JSON.parse(d));
    // 各 session に normal で同報
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.session).sort()).toEqual(['s1', 's2']);
    expect(sent.every((m) => m.mode === 'normal')).toBe(true);
  });
});

describe('WsController 操作intent送信', () => {
  it('sendMove: move エンベロープ', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    controller.sendMove('s1', { dir: 'N', mode: 'step' });
    const sent = ws.lastSent();
    expect(sent.type).toBe('move');
    expect(sent.session).toBe('s1');
    expect(sent.dir).toBe('N');
    expect(sent.mode).toBe('step');
  });

  it('sendCommand: command エンベロープ(付随フィールド透過)', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    controller.sendCommand('s1', { name: 'castMagic', spell: 'heal' });
    const sent = ws.lastSent();
    expect(sent.type).toBe('command');
    expect(sent.name).toBe('castMagic');
    expect(sent.spell).toBe('heal');
  });

  it('sendListSelect: 数値/all/cancel', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    controller.sendListSelect('s1', 3);
    expect(ws.lastSent().value).toBe(3);
    controller.sendListSelect('s1', 'all');
    expect(ws.lastSent().value).toBe('all');
    controller.sendListSelect('s1', 'cancel');
    expect(ws.lastSent().value).toBe('cancel');
  });

  it('submitEdit / cancelEdit', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    controller.submitEdit('s1', 'multi', ['a', 'b']);
    let sent = ws.lastSent();
    expect(sent.type).toBe('edit.submit');
    expect(sent.mode).toBe('multi');
    expect(sent.lines).toEqual(['a', 'b']);
    controller.cancelEdit('s1');
    sent = ws.lastSent();
    expect(sent.type).toBe('edit.cancel');
    expect(sent.session).toBe('s1');
  });
});

describe('CR-3 notice/worldTransfer/error 配線', () => {
  it('notice → noticeStore(部分更新)', async () => {
    setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.emit({
      type: 'notice',
      session: 's1',
      world: 'Fantasy Island',
      area: '港町',
      mapset: 'mansion',
    } as ServerMessage);
    expect(useNoticeStore.getState().bySession['s1'].world).toBe('Fantasy Island');
    expect(useNoticeStore.getState().bySession['s1'].area).toBe('港町');
    // area のみ更新 → world は温存
    ws.emit({ type: 'notice', session: 's1', area: '酒場' } as ServerMessage);
    expect(useNoticeStore.getState().bySession['s1'].world).toBe('Fantasy Island');
    expect(useNoticeStore.getState().bySession['s1'].area).toBe('酒場');
  });

  it('worldTransfer start → uiStore.worldTransfer 設定', async () => {
    setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.emit({
      type: 'worldTransfer',
      session: 's1',
      state: 'start',
      server: '1.2.3.4:5000',
    } as ServerMessage);
    expect(useUiStore.getState().worldTransfer?.state).toBe('start');
    expect(useUiStore.getState().worldTransfer?.server).toBe('1.2.3.4:5000');
  });

  it('worldTransfer fail → エラーバナーも push', async () => {
    setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.emit({ type: 'worldTransfer', session: 's1', state: 'fail' } as ServerMessage);
    expect(useUiStore.getState().worldTransfer?.state).toBe('fail');
    expect(useUiStore.getState().errors).toHaveLength(1);
    expect(useUiStore.getState().errors[0].code).toBe('TRANSFER_FAILED');
  });

  it('非相関 error → エラーバナー push', async () => {
    setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.emit({
      type: 'error',
      session: 's1',
      error: { code: 'LEGACY_DISCONNECTED', message: 'DM切断' },
    } as ServerMessage);
    expect(useUiStore.getState().errors).toHaveLength(1);
    expect(useUiStore.getState().errors[0].message).toBe('DM切断');
  });

  it('reqId付き error はバナーにしない(request側で reject 想定)', async () => {
    setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.emit({
      type: 'error',
      reqId: 'r-x',
      error: { code: 'BAD_REQUEST', message: 'x' },
    } as ServerMessage);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });
});

describe('L4 自己通知抑止(isSelfEcho / selfNameOf)', () => {
  function setSelfName(session: string, name: string) {
    useStatusStore.getState().setStatus(session, {
      name, hp: 1, maxHp: 1, mp: 0, maxMp: 0, exp: 0, gp: 0, f: 0, w: 0, m: 0, c: 0,
    });
  }

  it('selfNameOf: status 優先、無ければ notice', () => {
    setSelfName('s1', 'Hero');
    expect(selfNameOf('s1')).toBe('Hero');
    useNoticeStore.getState().setNotice('s2', { name: 'Mage' });
    expect(selfNameOf('s2')).toBe('Mage');
    expect(selfNameOf('s3')).toBeUndefined();
  });

  it('channel=log かつ from=自キャラ名 → 抑止対象', () => {
    setSelfName('s1', 'Hero');
    expect(isSelfEcho('s1', 'log', 'Hero')).toBe(true);
  });

  it('他者発言/他チャネル/from無しは抑止しない', () => {
    setSelfName('s1', 'Hero');
    expect(isSelfEcho('s1', 'log', 'Other')).toBe(false);
    expect(isSelfEcho('s1', 'priv', 'Hero')).toBe(false); // priv は抑止外
    expect(isSelfEcho('s1', 'loud', 'Hero')).toBe(false);
    expect(isSelfEcho('s1', 'log', undefined)).toBe(false);
  });

  it('自キャラ名未取得時は抑止しない', () => {
    expect(isSelfEcho('s9', 'log', 'Hero')).toBe(false);
  });
});

/** auth 応答を emit して WS auth ゲートを解除(保留送信をフラッシュ)。 */
function emitAuthOk(ws: MockWebSocket, isAdmin = false) {
  ws.emit({ type: 'auth', ok: true, isAdmin } as ServerMessage);
}

describe('CR-5 再接続時の token 自動再auth+reattach (A-33)', () => {
  it('再接続(open)で WS auth(token)自動再送 → 各セッション reattach(同 opener)', async () => {
    const { controller } = setup();
    await Promise.resolve(); // 初回 open
    let ws = MockWebSocket.last!;

    // 初回ログイン(REST 確立 → token 保持 → WS auth 送信)
    await controller.establishSession('phi-1');
    // auth ok でゲート解除
    emitAuthOk(ws);

    // セッションを開く(id 指定)
    const openP = controller.openSession({ id: 'phi-1' }, 'Hero');
    await Promise.resolve();
    ws.emit({ type: 'snapshot', session: 's1', reqId: ws.lastSent().reqId as string } as ServerMessage);
    await openP;
    expect(useSessionStore.getState().sessions['s1']).toBeDefined();

    const restCallsBefore = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.length;

    // 切断 → 再接続
    ws.close();
    controller.client.connect();
    await Promise.resolve(); // 2回目 open → token で auth 自動再送 + reattach 起動
    ws = MockWebSocket.last!;

    // 再接続直後に auth(token)が最初に送られる
    const firstSent = JSON.parse(ws.sent[0]);
    expect(firstSent.type).toBe('auth');
    expect(firstSent.token).toBe('tk-test');

    // auth ok でゲート解除 → 保留の session.open がフラッシュ
    emitAuthOk(ws);
    await new Promise((r) => setTimeout(r, 0));
    const reopen = ws.sent.map((d) => JSON.parse(d)).find((m) => m.type === 'session.open');
    expect(reopen).toBeDefined();
    expect(reopen.id).toBe('phi-1');

    // REST(establishSession)は再接続では呼ばれない(token 再利用)
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length)
      .toBe(restCallsBefore);
  });

  it('未ログイン(token 未保持)で再接続しても何も送らない', async () => {
    const { controller } = setup();
    await Promise.resolve(); // 初回 open
    const ws = MockWebSocket.last!;
    ws.close();
    controller.client.connect();
    await Promise.resolve();
    await Promise.resolve();
    const ws2 = MockWebSocket.last!;
    expect(ws2.sent).toHaveLength(0);
  });
});

describe('WsController WS auth ゲート (A-33)', () => {
  it('establishSession 前(token なし)は session.open がそのまま送られる', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    // token 無しなら従来動作(ゲート無し)
    const p = controller.openSession({ id: 'phi-1' }, 'Hero');
    await Promise.resolve();
    expect(ws.lastSent().type).toBe('session.open');
    ws.emit({ type: 'session.open', session: 's1', reqId: ws.lastSent().reqId as string, ok: true } as ServerMessage);
    await p;
  });

  it('token あり: auth ok 前は session.open を保留、ok 後にフラッシュ', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    await controller.establishSession('phi-1');
    ws.sent = []; // auth 送信分をクリア
    // auth ok 前に openSession
    const p = controller.openSession({ id: 'phi-1' }, 'Hero');
    await Promise.resolve();
    // まだ session.open は送られていない(保留)
    expect(ws.sent.find((d) => JSON.parse(d).type === 'session.open')).toBeUndefined();
    // auth ok → フラッシュ
    emitAuthOk(ws);
    await Promise.resolve();
    const reqId = ws.sent.map((d) => JSON.parse(d)).find((m) => m.type === 'session.open')!.reqId;
    ws.emit({ type: 'session.open', session: 's1', reqId, ok: true } as ServerMessage);
    const session = await p;
    expect(session).toBe('s1');
  });

  it('auth ok:false でログイン画面へ戻す(activeTab=null)', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    useUiStore.getState().setActiveTab('s1');
    await controller.establishSession('phi-1');
    ws.emit({ type: 'auth', ok: false, error: { code: 'AUTH_FAILED', message: 'token失効' } } as ServerMessage);
    expect(useUiStore.getState().activeTab).toBeNull();
    expect(useUiStore.getState().errors.length).toBeGreaterThan(0);
  });
});

describe('WsController.restore / logout (A-33)', () => {
  it('restore: localStorage に token あれば WS auth ゲート有効化', async () => {
    // 事前に token 保存(別ログイン相当)
    setStoredToken('tk-saved');
    const { controller } = setup();
    expect(controller.restore()).toBe(true);
    await Promise.resolve(); // open → auth 自動送信
    const ws = MockWebSocket.last!;
    const firstSent = JSON.parse(ws.sent[0]);
    expect(firstSent.type).toBe('auth');
    expect(firstSent.token).toBe('tk-saved');
  });

  it('restore: token 無ければ false', () => {
    const { controller } = setup();
    expect(controller.restore()).toBe(false);
  });

  it('logout: token クリア + session reset + activeTab=null', async () => {
    const { controller } = setup();
    await Promise.resolve();
    await controller.establishSession('phi-1');
    useUiStore.getState().setActiveTab('s1');
    useSessionStore.getState().addSession({ session: 's1', label: 'A', opener: { id: 'phi-1' } });
    await controller.logout();
    expect(getStoredToken()).toBeNull();
    expect(useUiStore.getState().activeTab).toBeNull();
    expect(Object.keys(useSessionStore.getState().sessions)).toHaveLength(0);
  });
});
