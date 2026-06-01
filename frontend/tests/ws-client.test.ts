import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WsClient } from '../src/ws/client';
import type { AuthRequest, ServerMessage } from '../src/types/protocol';

/**
 * mock WebSocket。
 * - 生成インスタンスを記録 → テストからサーバ側挙動を駆動。
 * - open/close/error/message を手動トリガ。
 */
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  sent: string[] = [];

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // --- テスト駆動用ヘルパ ---
  _open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }
  _emit(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  _emitRaw(data: string) {
    this.onmessage?.({ data });
  }
  _error() {
    this.onerror?.({});
  }

  static last(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
  static reset() {
    MockWebSocket.instances = [];
  }
}

describe('WsClient', () => {
  beforeEach(() => {
    MockWebSocket.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeClient(extra?: Partial<ConstructorParameters<typeof WsClient>[1]>) {
    return new WsClient('ws://test/ws', {
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      // jitter を決定的にしてテスト可能に
      jitter: () => 0,
      ...extra,
    });
  }

  it('connect で WebSocket を生成し open でハンドラ発火', () => {
    const client = makeClient();
    const onOpen = vi.fn();
    client.onLifecycle('open', onOpen);
    client.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.last().url).toBe('ws://test/ws');

    MockWebSocket.last()._open();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('send はエンベロープを JSON 文字列化して送信。ts を自動付与', () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();

    client.send({ type: 'move', dir: 'N', mode: 'step' });
    const sent = JSON.parse(MockWebSocket.last().sent[0]);
    expect(sent.type).toBe('move');
    expect(sent.dir).toBe('N');
    expect(typeof sent.ts).toBe('number');
  });

  it('open 前の send は接続後にフラッシュ', () => {
    const client = makeClient();
    client.connect();
    // open 前
    client.send({ type: 'ping', nonce: 'a' });
    expect(MockWebSocket.last().sent).toHaveLength(0);

    MockWebSocket.last()._open();
    expect(MockWebSocket.last().sent).toHaveLength(1);
    expect(JSON.parse(MockWebSocket.last().sent[0]).type).toBe('ping');
  });

  it('request は reqId を採番し送信。応答(同reqId)で resolve', async () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();

    const p = client.request<AuthRequest>({ type: 'auth', id: 'u', password: 'p' });
    const sent = JSON.parse(MockWebSocket.last().sent[0]);
    expect(sent.type).toBe('auth');
    expect(typeof sent.reqId).toBe('string');

    MockWebSocket.last()._emit({
      type: 'auth',
      reqId: sent.reqId,
      ok: true,
      characters: [{ charId: 'c1', name: 'X' }],
    } as ServerMessage);

    const res = await p;
    expect(res.type).toBe('auth');
    expect((res as { ok: boolean }).ok).toBe(true);
  });

  it('型dispatch: type別ハンドラに narrow した payload を渡す', () => {
    const client = makeClient();
    const onMap = vi.fn();
    const onStatus = vi.fn();
    client.on('map', onMap);
    client.on('status', onStatus);
    client.connect();
    MockWebSocket.last()._open();

    MockWebSocket.last()._emit({
      type: 'status',
      name: 'X',
      hp: 10,
      maxHp: 10,
      mp: 5,
      maxMp: 5,
      exp: 0,
      gp: 0,
      f: 1,
      w: 2,
      m: 3,
      c: 4,
    } as ServerMessage);

    expect(onStatus).toHaveBeenCalledOnce();
    expect(onStatus.mock.calls[0][0].hp).toBe(10);
    expect(onMap).not.toHaveBeenCalled();
  });

  it('snapshot 受信フック onSnapshot が発火', () => {
    const client = makeClient();
    const onSnap = vi.fn();
    client.onSnapshot(onSnap);
    client.connect();
    MockWebSocket.last()._open();

    MockWebSocket.last()._emit({
      type: 'snapshot',
      status: { name: 'X', hp: 1, maxHp: 1, mp: 0, maxMp: 0, exp: 0, gp: 0, f: 0, w: 0, m: 0, c: 0 },
    } as ServerMessage);

    expect(onSnap).toHaveBeenCalledOnce();
    expect(onSnap.mock.calls[0][0].status.hp).toBe(1);
  });

  it('不正JSONは無視(例外を投げない)', () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();
    expect(() => MockWebSocket.last()._emitRaw('{not json')).not.toThrow();
  });

  it('未知 type は無視(前方互換)', () => {
    const client = makeClient();
    const onAny = vi.fn();
    client.on('map', onAny);
    client.connect();
    MockWebSocket.last()._open();
    expect(() =>
      MockWebSocket.last()._emitRaw('{"type":"futureThing","x":1}'),
    ).not.toThrow();
    expect(onAny).not.toHaveBeenCalled();
  });

  it('close で指数バックオフ再接続(1s,2s,4s...) + 新WS生成', () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();
    expect(MockWebSocket.instances).toHaveLength(1);

    // 1回目 close → 1s 後に再接続
    MockWebSocket.last()._open();
    MockWebSocket.last().close();
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // 2回目 close → 2s 後
    MockWebSocket.last().close();
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // 3回目 close → 4s 後
    MockWebSocket.last().close();
    vi.advanceTimersByTime(4000);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('バックオフは 30s で頭打ち', () => {
    const client = makeClient();
    client.connect();
    // 大量に失敗させて attempt を増やす
    for (let i = 0; i < 10; i++) {
      MockWebSocket.last()._open();
      MockWebSocket.last().close();
      vi.advanceTimersByTime(30_000);
    }
    const before = MockWebSocket.instances.length;
    MockWebSocket.last().close();
    vi.advanceTimersByTime(30_000);
    expect(MockWebSocket.instances.length).toBe(before + 1);
  });

  it('再接続成功で attempt リセット(次の close は再び 1s)', () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();
    MockWebSocket.last().close();
    vi.advanceTimersByTime(1000); // 1回目再接続
    MockWebSocket.last()._open(); // 成功 → リセット
    MockWebSocket.last().close();
    vi.advanceTimersByTime(999);
    const n = MockWebSocket.instances.length;
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(n + 1); // また1s
  });

  it('connection イベントで state を保持', () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();
    MockWebSocket.last()._emit({ type: 'connection', state: 'connected' } as ServerMessage);
    expect(client.getConnectionState()).toBe('connected');
  });

  it('disconnect 後は再接続しない', () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();
    client.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('CR-14: request は無応答でタイムアウト reject', async () => {
    const client = makeClient({ requestTimeoutMs: 10_000 });
    client.connect();
    MockWebSocket.last()._open();
    const p = client.request<AuthRequest>({ type: 'auth', id: 'u', password: 'p' });
    // reject を捕捉(unhandled rejection 防止)
    const caught = p.catch((e) => e);
    vi.advanceTimersByTime(10_000);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as { reason?: string }).reason).toBe('timeout');
  });

  it('CR-14: 切断で pending を全 reject', async () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();
    const p1 = client.request<AuthRequest>({ type: 'auth', id: 'u', password: 'p' });
    const c1 = p1.catch((e) => e);
    MockWebSocket.last().close();
    const err = await c1;
    expect((err as { reason?: string }).reason).toBe('closed');
  });

  it('CR-14: disconnect で pending を reject', async () => {
    const client = makeClient();
    client.connect();
    MockWebSocket.last()._open();
    const p = client.request<AuthRequest>({ type: 'auth', id: 'u', password: 'p' });
    const c = p.catch((e) => e);
    client.disconnect();
    const err = await c;
    expect((err as { reason?: string }).reason).toBe('closed');
  });

  it('CR-14: 応答受信でタイムアウトタイマをクリア(後の advance で reject しない)', async () => {
    const client = makeClient({ requestTimeoutMs: 10_000 });
    client.connect();
    MockWebSocket.last()._open();
    const p = client.request<AuthRequest>({ type: 'auth', id: 'u', password: 'p' });
    const reqId = JSON.parse(MockWebSocket.last().sent[0]).reqId;
    MockWebSocket.last()._emit({ type: 'auth', reqId, ok: true } as ServerMessage);
    const res = await p;
    expect((res as { ok: boolean }).ok).toBe(true);
    // タイマが残っていれば reject されてしまうが、解決済みなので無害
    vi.advanceTimersByTime(20_000);
  });

  it('off でハンドラ解除', () => {
    const client = makeClient();
    const onMap = vi.fn();
    client.on('map', onMap);
    client.off('map', onMap);
    client.connect();
    MockWebSocket.last()._open();
    MockWebSocket.last()._emit({
      type: 'map',
      size: 5,
      dir: 0,
      style: 'solid',
      mapset: 'x',
      cells: [],
      chars: [],
    } as ServerMessage);
    expect(onMap).not.toHaveBeenCalled();
  });
});
