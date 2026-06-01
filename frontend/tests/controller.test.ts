import { describe, it, expect, beforeEach } from 'vitest';
import { WsClient } from '../src/ws/client';
import { WsController } from '../src/ws/controller';
import { useSessionStore } from '../src/stores/sessionStore';
import { useStatusStore } from '../src/stores/statusStore';
import { useChatStore } from '../src/stores/chatStore';
import { useConnectionStore } from '../src/stores/connectionStore';
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
});
