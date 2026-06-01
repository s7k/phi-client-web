import { describe, it, expect, beforeEach } from 'vitest';
import { WsClient } from '../src/ws/client';
import { WsController, isSelfEcho, selfNameOf } from '../src/ws/controller';
import { useSessionStore } from '../src/stores/sessionStore';
import { useStatusStore } from '../src/stores/statusStore';
import { useChatStore } from '../src/stores/chatStore';
import { useConnectionStore } from '../src/stores/connectionStore';
import { useNoticeStore } from '../src/stores/noticeStore';
import { useUiStore } from '../src/stores/uiStore';
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

beforeEach(() => {
  useSessionStore.getState().reset();
  useStatusStore.getState().reset();
  useChatStore.getState().reset();
  useConnectionStore.getState().reset();
  useNoticeStore.getState().reset();
  useUiStore.getState().reset();
  MockWebSocket.last = null;
});

describe('WsController.auth', () => {
  it('reqIdエコー応答でキャラ一覧を格納', async () => {
    const { controller } = setup();
    await Promise.resolve(); // open フラッシュ
    const ws = MockWebSocket.last!;

    const p = controller.auth('user', 'pw');
    const req = ws.lastSent();
    expect(req.type).toBe('auth');
    expect(req.id).toBe('user');
    expect(typeof req.reqId).toBe('string');

    // BE が同 reqId をエコー
    ws.emit({
      type: 'auth',
      reqId: req.reqId as string,
      ok: true,
      characters: [{ charId: 'c1', name: 'A' }],
    });
    const chars = await p;
    expect(chars).toHaveLength(1);
    expect(useSessionStore.getState().characters[0].name).toBe('A');
  });

  it('ok=false で reject', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    const p = controller.auth('user', 'bad');
    const reqId = ws.lastSent().reqId as string;
    ws.emit({
      type: 'auth',
      reqId,
      ok: false,
      error: { code: 'AUTH_FAILED', message: '認証失敗' },
    });
    await expect(p).rejects.toThrow('認証失敗');
  });
});

describe('WsController.openSession', () => {
  it('応答のsessionを登録・アクティブ化', async () => {
    const { controller } = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    const p = controller.openSession('c1');
    const reqId = ws.lastSent().reqId as string;
    ws.emit({ type: 'snapshot', session: 's1', reqId } as ServerMessage);
    const session = await p;
    expect(session).toBe('s1');
    expect(useSessionStore.getState().active).toBe('s1');
    expect(useSessionStore.getState().sessions['s1'].charId).toBe('c1');
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
    useSessionStore.getState().addSession('s1', 'c1');
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
    useSessionStore.getState().addSession('s1', 'c1');
    useSessionStore.getState().addSession('s2', 'c2');
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

describe('CR-5 再接続時の自動再認証+reattach', () => {
  it('再接続(open)で auth → 各セッション reattach', async () => {
    const { controller } = setup();
    await Promise.resolve(); // 初回 open
    let ws = MockWebSocket.last!;

    // 初回ログイン(資格保持)
    const authP = controller.auth('user', 'pw');
    ws.emit({
      type: 'auth',
      reqId: ws.lastSent().reqId as string,
      ok: true,
      characters: [{ charId: 'c1', name: 'A' }],
    });
    await authP;

    // セッションを開く
    const openP = controller.openSession('c1');
    ws.emit({ type: 'snapshot', session: 's1', reqId: ws.lastSent().reqId as string } as ServerMessage);
    await openP;
    expect(useSessionStore.getState().sessions['s1']).toBeDefined();

    // 切断 → 再接続
    ws.close();
    // autoReconnect=false なので手動で再接続
    controller.client.connect();
    await Promise.resolve(); // 2回目 open → reattach 起動
    ws = MockWebSocket.last!;

    // reattach: 自動 auth が送られる
    await Promise.resolve();
    const reauth = JSON.parse(ws.sent[0]);
    expect(reauth.type).toBe('auth');
    expect(reauth.id).toBe('user');
    // auth 応答 → 続いて session.open(reattach)
    ws.emit({
      type: 'auth',
      reqId: reauth.reqId,
      ok: true,
      characters: [{ charId: 'c1', name: 'A' }],
    });
    await new Promise((r) => setTimeout(r, 0));
    const reopen = JSON.parse(ws.sent[1]);
    expect(reopen.type).toBe('session.open');
    expect(reopen.charId).toBe('c1');
  });

  it('未ログイン(資格なし)で再接続しても auth を送らない', async () => {
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
