/**
 * F1 WebSocket クライアント（契約 = docs/07-ws-protocol.md, 再接続 = docs/12 §6）。
 *
 * 機能:
 * - エンベロープ送受信(UTF-8 JSON, 1フレーム=1メッセージ)。
 * - type別の型安全 dispatch(on/off)。
 * - reqId採番付き request/応答相関。
 * - snapshot 受信フック。
 * - 再接続: 指数バックオフ min(30s, 1s*2^n) + jitter([12]§6)。
 *
 * 注: WS切断中のFE送信はキューせず破棄(ゲーム操作は最新状態前提)が原則([12]§6)。
 *     ただし「open前(接続確立待ち)」の送信は接続後にフラッシュする。
 */

import type {
  ClientMessage,
  ConnectionState,
  ServerMessage,
  ServerMessageOf,
  ServerMessageType,
  SnapshotEvent,
} from '../types/protocol';

/** 各 S→C type に対応するハンドラ。payload は narrow 済み。 */
type MessageHandler<T extends ServerMessageType> = (
  msg: ServerMessageOf<T>,
) => void;

/** ライフサイクルイベント。 */
type LifecycleEvent = 'open' | 'close' | 'error';
type LifecycleHandler = (info?: unknown) => void;

export interface WsClientOptions {
  /** WebSocket 実装の差し替え(テスト用)。既定はグローバル WebSocket。 */
  WebSocketImpl?: typeof WebSocket;
  /** バックオフ基準(ms)。既定 1000。 */
  backoffBaseMs?: number;
  /** バックオフ上限(ms)。既定 30000。 */
  backoffMaxMs?: number;
  /** jitter(ms)生成器。既定はランダム(0..1000)。テストで決定化可。 */
  jitter?: () => number;
  /** reqId 生成器。既定はランダム。 */
  reqIdGen?: () => string;
  /** 自動再接続するか。既定 true。 */
  autoReconnect?: boolean;
  /** request() の応答待ちタイムアウト(ms)。既定 10000。0以下で無効。 */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (msg: ServerMessage) => void;
  reject: (err: unknown) => void;
  /** タイムアウトタイマ(あれば)。reject 時に必ずクリア。 */
  timer: ReturnType<typeof setTimeout> | null;
}

/** request() が未応答/切断で reject される際のエラー。 */
export class WsRequestError extends Error {
  constructor(
    message: string,
    readonly reason: 'timeout' | 'closed',
  ) {
    super(message);
    this.name = 'WsRequestError';
  }
}

export class WsClient {
  private readonly url: string;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly jitter: () => number;
  private readonly reqIdGen: () => string;
  private readonly autoReconnect: boolean;
  private readonly requestTimeoutMs: number;

  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  /**
   * WS 認証トークン(A-33)。設定されると open 後に最初に
   * `{type:"auth", token}` を送り、auth ok 応答まで他送信を保留する。
   * null の場合は認証ゲート無し(従来動作)。
   */
  private authToken: string | null = null;
  /** auth ok 応答待ち(true の間、auth以外の send は outbox に保留)。 */
  private awaitingAuth = false;

  /** open 前に積まれた送信(接続確立でフラッシュ)。 */
  private outbox: string[] = [];

  /** レガシー接続状態(connection イベント由来)。 */
  private connectionState: ConnectionState = 'connecting';

  /** type別ハンドラ集合。 */
  private handlers = new Map<string, Set<(msg: ServerMessage) => void>>();
  /** ライフサイクルハンドラ。 */
  private lifecycle = new Map<LifecycleEvent, Set<LifecycleHandler>>();
  /** snapshot 専用フック。 */
  private snapshotHandlers = new Set<(msg: SnapshotEvent) => void>();
  /** reqId → pending。 */
  private pending = new Map<string, PendingRequest>();

  constructor(url: string, options: WsClientOptions = {}) {
    this.url = url;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.jitter = options.jitter ?? (() => Math.random() * 1000);
    this.reqIdGen = options.reqIdGen ?? defaultReqId;
    this.autoReconnect = options.autoReconnect ?? true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  // ---------- 接続制御 ----------

  /**
   * WS 認証トークンを設定/更新(A-33)。
   * 以後の接続(open)時に最初に `{type:"auth", token}` を送り、
   * auth ok 応答まで他の送信を保留する。null でゲート解除。
   * すでに open 済みで token が新規設定された場合は即座に auth を送る。
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;
    if (token && this.isOpen() && !this.awaitingAuth) {
      this.startAuth();
    }
  }

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  /** 明示切断。以後 autoReconnect しない。pending は全 reject(CR-14)。 */
  disconnect(code?: number, reason?: string): void {
    this.closedByUser = true;
    this.clearReconnect();
    this.rejectAllPending('closed', 'WS切断により要求を中断');
    this.ws?.close(code, reason);
    this.ws = null;
  }

  /** 手動再接続(再接続ボタン用 [12]§6)。 */
  reconnectNow(): void {
    this.clearReconnect();
    this.attempt = 0;
    this.openSocket();
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  isOpen(): boolean {
    return this.ws?.readyState === this.WebSocketImpl.OPEN;
  }

  private openSocket(): void {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;

    ws.onopen = (ev) => {
      this.attempt = 0; // 成功でリセット
      if (this.authToken) {
        // A-33: 認証ゲート。最初に auth を送り、ok 応答まで他送信を保留。
        // この時点で outbox(再接続前の保留)はフラッシュせず auth ok まで待つ。
        this.startAuth();
      } else {
        this.flushOutbox();
      }
      this.emitLifecycle('open', ev);
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.handleRaw(ev.data);
    };

    ws.onerror = (ev) => {
      this.emitLifecycle('error', ev);
    };

    ws.onclose = (ev) => {
      // 切断時、応答が来ない pending を全 reject(CR-14: 永久pending防止)。
      this.rejectAllPending('closed', 'WS切断により応答未達');
      // 認証ゲートは再接続で再度 auth からやり直す。
      this.awaitingAuth = false;
      this.emitLifecycle('close', ev);
      this.ws = null;
      if (!this.closedByUser && this.autoReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    const delay =
      Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt) +
      this.jitter();
    this.attempt++;
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---------- 送信 ----------

  /**
   * エンベロープを送信。open前/認証ゲート中(auth以外)は outbox に積む。
   * auth メッセージ自体は認証ゲートを素通りする(A-33)。
   */
  send(msg: ClientMessage): void {
    const withTs = { ts: Date.now(), ...msg };
    const data = JSON.stringify(withTs);
    const isAuthMsg = msg.type === 'auth';
    if (this.isOpen() && (!this.awaitingAuth || isAuthMsg)) {
      this.ws!.send(data);
    } else {
      this.outbox.push(data);
    }
  }

  /** auth ゲート開始: `{type:"auth", token}` を即送信し ok 応答を待つ。 */
  private startAuth(): void {
    if (!this.authToken) return;
    this.awaitingAuth = true;
    // send() は auth を素通しさせる(awaitingAuth=true でも type==='auth' は送る)。
    this.send({ type: 'auth', token: this.authToken });
  }

  /**
   * reqId付き要求を送り、同 reqId の応答で resolve する Promise を返す。
   * 呼び出し側は reqId を省略(自動採番)。
   */
  request<T extends ClientMessage>(
    msg: Omit<T, 'reqId'> & { reqId?: string },
  ): Promise<ServerMessage> {
    const reqId = msg.reqId ?? this.reqIdGen();
    const full = { ...msg, reqId } as ClientMessage;
    return new Promise<ServerMessage>((resolve, reject) => {
      // タイムアウト: 無応答時に reject(CR-14)。
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (this.requestTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(reqId)) {
            reject(
              new WsRequestError(
                `要求 ${reqId} が ${this.requestTimeoutMs}ms 以内に応答なし`,
                'timeout',
              ),
            );
          }
        }, this.requestTimeoutMs);
      }
      this.pending.set(reqId, { resolve, reject, timer });
      this.send(full);
    });
  }

  /** 全 pending を reject(切断/明示切断時)。タイマもクリア(CR-14)。 */
  private rejectAllPending(reason: 'timeout' | 'closed', message: string): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const p of entries) {
      if (p.timer !== null) clearTimeout(p.timer);
      p.reject(new WsRequestError(message, reason));
    }
  }

  private flushOutbox(): void {
    if (this.awaitingAuth) return; // 認証ゲート中はフラッシュしない(A-33)。
    if (this.outbox.length === 0) return;
    const pending = this.outbox;
    this.outbox = [];
    for (const data of pending) {
      this.ws!.send(data);
    }
  }

  // ---------- 受信・dispatch ----------

  private handleRaw(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      // 不正JSONは無視([07] 前方互換方針)
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    // reqId応答の相関
    if (msg.reqId && this.pending.has(msg.reqId)) {
      const p = this.pending.get(msg.reqId)!;
      this.pending.delete(msg.reqId);
      if (p.timer !== null) clearTimeout(p.timer);
      p.resolve(msg);
      // 応答も通常 dispatch へ流す(購読者がいれば)
    }

    // A-33: WS 認証応答。ok で認証ゲート解除 → 保留送信をフラッシュ。
    // 失敗(ok:false)はゲートを開けず、購読者(controller)がエラー処理する。
    if (msg.type === 'auth' && this.awaitingAuth) {
      if (msg.ok !== false) {
        this.awaitingAuth = false;
        this.flushOutbox();
      }
    }

    // 接続状態の追跡
    if (msg.type === 'connection') {
      this.connectionState = msg.state;
    }

    // snapshot 専用フック
    if (msg.type === 'snapshot') {
      for (const h of this.snapshotHandlers) h(msg as SnapshotEvent);
    }

    // type別 dispatch
    const set = this.handlers.get(msg.type);
    if (set) {
      for (const h of set) h(msg);
    }
    // 未知 type はハンドラ無し → 無視(前方互換)
  }

  // ---------- 購読 ----------

  /** type別ハンドラ登録。 */
  on<T extends ServerMessageType>(type: T, handler: MessageHandler<T>): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as (msg: ServerMessage) => void);
  }

  off<T extends ServerMessageType>(type: T, handler: MessageHandler<T>): void {
    this.handlers.get(type)?.delete(handler as (msg: ServerMessage) => void);
  }

  /** snapshot 受信フック([07]§4.2)。 */
  onSnapshot(handler: (msg: SnapshotEvent) => void): () => void {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  /** ライフサイクル(open/close/error)購読。 */
  onLifecycle(event: LifecycleEvent, handler: LifecycleHandler): void {
    let set = this.lifecycle.get(event);
    if (!set) {
      set = new Set();
      this.lifecycle.set(event, set);
    }
    set.add(handler);
  }

  private emitLifecycle(event: LifecycleEvent, info?: unknown): void {
    const set = this.lifecycle.get(event);
    if (set) for (const h of set) h(info);
  }
}

/** 既定 reqId 生成器(crypto.randomUUID があれば使用)。 */
function defaultReqId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
