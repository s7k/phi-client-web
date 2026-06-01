import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WsClient } from '../src/ws/client';
import { WsController } from '../src/ws/controller';
import { WsProvider } from '../src/ws/WsContext';
import { Settings } from '../src/components/Settings';
import { useSettingsStore } from '../src/stores/settingsStore';
import { useUiStore } from '../src/stores/uiStore';
import type { ServerMessage } from '../src/types/protocol';

/** controller.test.ts と同型の mock WS。 */
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
  MockWebSocket.last = null;
});

describe('WsController.getSettings', () => {
  it('settings.get を送り応答 value を store へ反映', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    const p = controller.getSettings('display');
    const req = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(req.type).toBe('settings.get');
    expect(req.scope).toBe('display');
    ws.emit({
      type: 'settings',
      reqId: req.reqId,
      ok: true,
      scope: 'display',
      value: { mapSize: 40, mapStyle: 'turn', eagleEye: true, fontScale: 1.2, theme: 'light' },
    } as ServerMessage);
    const value = await p;
    expect((value as { mapSize: number }).mapSize).toBe(40);
    expect((useSettingsStore.getState().byScope['display'] as { theme: string }).theme).toBe('light');
  });
});

describe('WsController.setSettings', () => {
  it('settings.set を送り store を楽観更新', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.sent = [];
    controller.setSettings('notify', { enabled: false });
    const req = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(req.type).toBe('settings.set');
    expect(req.scope).toBe('notify');
    expect(req.value).toEqual({ enabled: false });
    expect((useSettingsStore.getState().byScope['notify'] as { enabled: boolean }).enabled).toBe(false);
  });
});

describe('Settings コンポーネント(F10)', () => {
  it('settingsOpen=false は描画しない', () => {
    const controller = setup();
    const { container } = render(
      <WsProvider controller={controller}>
        <Settings />
      </WsProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('open 時に各 scope を settings.get 取得', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    ws.sent = [];
    useUiStore.getState().setSettingsOpen(true);
    render(
      <WsProvider controller={controller}>
        <Settings />
      </WsProvider>,
    );
    await waitFor(() => {
      const scopes = ws
        .sentParsed()
        .filter((m) => m.type === 'settings.get')
        .map((m) => m.scope)
        .sort();
      expect(scopes).toEqual(['display', 'intervals', 'keybind', 'notify']);
    });
  });

  it('display 変更で settings.set 送信(view連動 mapStyle)', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    useUiStore.getState().setSettingsOpen(true);
    render(
      <WsProvider controller={controller}>
        <Settings />
      </WsProvider>,
    );
    ws.sent = [];
    fireEvent.change(screen.getByLabelText('マップ方式'), { target: { value: 'turn' } });
    const setMsg = ws.sentParsed().find((m) => m.type === 'settings.set' && m.scope === 'display');
    expect(setMsg).toBeTruthy();
    expect(setMsg.value.mapStyle).toBe('turn');
  });

  it('keybind magic(F1)入力で settings.set', async () => {
    const controller = setup();
    await Promise.resolve();
    const ws = MockWebSocket.last!;
    useUiStore.getState().setSettingsOpen(true);
    render(
      <WsProvider controller={controller}>
        <Settings />
      </WsProvider>,
    );
    ws.sent = [];
    fireEvent.change(screen.getByLabelText('magic-F1'), { target: { value: 'heal' } });
    const setMsg = ws.sentParsed().find((m) => m.type === 'settings.set' && m.scope === 'keybind');
    expect(setMsg.value.magic.F1).toBe('heal');
  });

  it('閉じるボタンで settingsOpen=false', async () => {
    const controller = setup();
    await Promise.resolve();
    useUiStore.getState().setSettingsOpen(true);
    render(
      <WsProvider controller={controller}>
        <Settings />
      </WsProvider>,
    );
    fireEvent.click(screen.getByLabelText('閉じる'));
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });
});
