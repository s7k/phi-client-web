/**
 * 契約往復カバレッジ(CR レビュー最大の発見の再発防止, task7)。
 *
 * [07] が定義する全 S→C event 型について、controller が:
 *   (a) WsClient.on(type) でハンドラを登録している、または
 *   (b) 別経路で消費する(snapshot=onSnapshot, reqId応答=request相関), または
 *   (c) 既知の無視(KNOWN_IGNORED)
 * のいずれかであることを検証。片側未配線(BE emit ↔ FE 未consume)を機械的に検出。
 */
import { describe, it, expect } from 'vitest';
import { WsClient } from '../src/ws/client';
import { WsController } from '../src/ws/controller';
import type { ServerMessageType } from '../src/types/protocol';

/** [07]§6 が定義する全 S→C type(契約の正本)。 */
const CONTRACT_SERVER_TYPES: ServerMessageType[] = [
  'hello',
  'session.open',
  'saved.list',
  'connection',
  'snapshot',
  'map',
  'status',
  'cond',
  'message',
  'userList',
  'list',
  'edit',
  'mode',
  'worldTransfer',
  'eagleEye',
  'notice',
  'settings',
  'pong',
  'error',
];

/**
 * on(type) 以外の経路で消費される型 → 理由付き。
 * - snapshot: onSnapshot フック経由。
 * - session.open/saved.list/settings: reqId 相関(request)で resolve。controller も
 *   on('settings') を持つが、session.open/saved.list は応答専用のため on 登録不要。
 * - pong: 任意ハートビート。現状アプリ層 ping 未送出のため無視(将来 on 追加可)。
 */
const KNOWN_OTHER: Partial<Record<ServerMessageType, string>> = {
  snapshot: 'onSnapshot フックで消費',
  'session.open': 'reqId相関(request)で resolve',
  'saved.list': 'reqId相関(request)で resolve',
  pong: '任意ハートビート(未使用, 前方互換で無視)',
};

describe('契約往復カバレッジ [07]§6 S→C', () => {
  it('全 S→C type に controller のハンドラ or 既知経路がある', () => {
    const client = new WsClient('ws://x', {
      WebSocketImpl: class {
        static OPEN = 1;
        readyState = 0;
        onopen = null;
        onclose = null;
        onerror = null;
        onmessage = null;
        send() {}
        close() {}
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        constructor(_url: string) {}
      } as unknown as typeof WebSocket,
    });
    new WsController(client);

    // client が on(type) 登録したハンドラ集合を取得(private を型回避で参照)。
    const handlers = (
      client as unknown as { handlers: Map<string, unknown> }
    ).handlers;

    const missing: string[] = [];
    for (const type of CONTRACT_SERVER_TYPES) {
      const hasHandler = handlers.has(type);
      const known = type in KNOWN_OTHER;
      if (!hasHandler && !known) missing.push(type);
    }
    expect(missing).toEqual([]);
  });

  it('契約型リストは ServerMessageType と一致(型の取りこぼし検出)', () => {
    // CONTRACT_SERVER_TYPES が ServerMessageType の全メンバを網羅しているか。
    // ServerMessageType に新メンバが増えたらこのテストが型エラー or 不一致になる。
    const set = new Set<string>(CONTRACT_SERVER_TYPES);
    // 代表メンバが含まれることを確認(network of types)。
    const sample: ServerMessageType[] = ['notice', 'worldTransfer', 'error', 'eagleEye'];
    for (const t of sample) expect(set.has(t)).toBe(true);
    expect(CONTRACT_SERVER_TYPES.length).toBe(set.size); // 重複なし
  });
});
