import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WsClient } from '../src/ws/client';
import { WsController } from '../src/ws/controller';
import { WsProvider } from '../src/ws/WsContext';
import { Settings } from '../src/components/Settings';
import { useSettingsStore } from '../src/stores/settingsStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSessionStore } from '../src/stores/sessionStore';
import { useMapStore } from '../src/stores/mapStore';
import { useStatusStore } from '../src/stores/statusStore';
import { useUserStore } from '../src/stores/userStore';
import { useConnectionStore } from '../src/stores/connectionStore';
import type { ServerMessage } from '../src/types/protocol';

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
  sentParsed() {
    return this.sent.map((d) => JSON.parse(d));
  }
  lastSent() {
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
  return controller;
}

beforeEach(() => {
  useSettingsStore.getState().reset();
  useUiStore.getState().reset();
  useSessionStore.getState().reset();
  useMapStore.getState().reset();
  useStatusStore.getState().reset();
  useUserStore.getState().reset();
  useConnectionStore.getState().reset();
  MockWebSocket.last = null;
  // establishSession の REST を成功スタブ化(cookie 発行を模す)。
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, isAdmin: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// A-24 view.set 連動
// ============================================================

describe('WsController.sendViewSet (A-24)', () => {
  it('指定項目のみ view.set 送信', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.sent = [];
    controller.sendViewSet({ mapStyle: 'turn' });
    const sent = ws.lastSent();
    expect(sent.type).toBe('view.set');
    expect(sent.mapStyle).toBe('turn');
    expect('mapSize' in sent).toBe(false);
    expect('eagleEye' in sent).toBe(false);
  });

  it('アクティブ session を付与', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    useSessionStore.getState().addSession({ session: 's1', label: 'A', opener: { id: 'phi-1' } });
    useSessionStore.getState().setActive('s1');
    ws.sent = [];
    controller.sendViewSet({ eagleEye: true });
    expect(ws.lastSent().session).toBe('s1');
  });
});

describe('Settings display 変更で view.set 連動送信', () => {
  function openSettings(controller: WsController) {
    useUiStore.getState().setSettingsOpen(true);
    render(
      <WsProvider controller={controller}>
        <Settings />
      </WsProvider>,
    );
  }

  it('mapSize 変更で settings.set + view.set(mapSize)', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    openSettings(controller);
    ws.sent = [];
    fireEvent.change(screen.getByLabelText('マップサイズ'), { target: { value: '40' } });
    const sent = ws.sentParsed();
    const setMsg = sent.find((m) => m.type === 'settings.set' && m.scope === 'display');
    const viewMsg = sent.find((m) => m.type === 'view.set');
    expect(setMsg).toBeTruthy();
    expect(viewMsg).toBeTruthy();
    expect(viewMsg.mapSize).toBe(40);
  });

  it('mapStyle 変更で view.set(mapStyle)', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    openSettings(controller);
    ws.sent = [];
    fireEvent.change(screen.getByLabelText('マップ方式'), { target: { value: 'turn' } });
    const viewMsg = ws.sentParsed().find((m) => m.type === 'view.set');
    expect(viewMsg.mapStyle).toBe('turn');
  });

  it('eagleEye 変更で view.set(eagleEye)', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    openSettings(controller);
    ws.sent = [];
    fireEvent.click(screen.getByLabelText('EagleEye'));
    const viewMsg = ws.sentParsed().find((m) => m.type === 'view.set');
    expect(viewMsg.eagleEye).toBe(true);
  });

  it('display 以外(fontScale)変更では view.set を送らない', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    openSettings(controller);
    ws.sent = [];
    fireEvent.change(screen.getByLabelText('文字倍率'), { target: { value: '1.5' } });
    const viewMsg = ws.sentParsed().find((m) => m.type === 'view.set');
    expect(viewMsg).toBeUndefined();
  });
});

// ============================================================
// 統合フロー(connect→auth→session.open→snapshot→各store反映)
// ============================================================

describe('統合フロー(mock WS)', () => {
  it('establishSession → session.open → snapshot で各 store に反映', async () => {
    const controller = setup();
    await Promise.resolve(); // open フラッシュ
    const ws = MockWebSocket.last!;

    // hello 受信
    ws.emit({ type: 'hello', protocolVersion: 1, serverTime: 0 } as ServerMessage);
    expect(useConnectionStore.getState().protocolVersion).toBe(1);

    // ログイン(ID-only, REST 確立)
    const res = await controller.establishSession('phi-1');
    expect(res.ok).toBe(true);

    // session.open(id 指定)
    const openP = controller.openSession({ id: 'phi-1' }, 'Hero');
    const openReqId = ws.lastSent().reqId as string;
    ws.emit({
      type: 'snapshot',
      session: 's1',
      reqId: openReqId,
      status: {
        name: 'Hero',
        hp: 80,
        maxHp: 100,
        mp: 10,
        maxMp: 20,
        exp: 5,
        gp: 3,
        f: 1,
        w: 0,
        m: 0,
        c: 0,
      },
      userList: { users: [{ key: 'u1', name: 'Bob' }] },
      map: {
        size: 5,
        dir: 0,
        style: 'solid',
        mapset: 'town',
        cells: Array.from({ length: 25 }, () => ({ chip: 0, attr: 0 })),
        chars: [],
      },
    } as ServerMessage);
    const session = await openP;
    expect(session).toBe('s1');
    expect(useSessionStore.getState().active).toBe('s1');

    // snapshot が各 store に反映されている
    expect(useStatusStore.getState().bySession['s1'].status?.hp).toBe(80);
    expect(useUserStore.getState().bySession['s1'][0].name).toBe('Bob');
    expect(useMapStore.getState().bySession['s1']?.mapset).toBe('town');

    // 後続イベントも反映(connection 状態)
    ws.emit({ type: 'connection', session: 's1', state: 'connected' } as ServerMessage);
    expect(useConnectionStore.getState().sessions['s1']).toBe('connected');
  });
});
