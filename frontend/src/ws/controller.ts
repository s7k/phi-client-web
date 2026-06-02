/**
 * WsController — WsClient と stores の配線層。
 *
 * 責務:
 * - WS イベント(hello/connection/snapshot/map/status/cond/message/userList/mode/list/edit)
 *   を受け取り対応 store へ反映。
 * - login/register(REST) / characters CRUD(REST) / session.open(charId) / chat 等の送信ヘルパ。
 * - A-02: reqId は WsClient.request が採番、BE がエコー。
 * - A-03: S→C は常に session 付与。session 欠落時はアクティブ session で補完。
 *
 * UI(コンポーネント)はこのコントローラ経由で操作し、store を購読する。
 */
import { WsClient } from './client';
import type {
  ChatMode,
  CommandRequest,
  Dir,
  ListSelectRequest,
  MoveMode,
  TurnDir,
  ServerMessage,
  SessionOpenRequest,
  SessionOpenResponse,
  SettingsGetRequest,
  SettingsResponse,
  SettingsScope,
  SettingsSetRequest,
  ViewSetRequest,
} from '../types/protocol';
import {
  login as restLogin,
  register as restRegister,
  logout as restLogout,
  getStoredToken,
  setStoredToken,
  clearStoredToken,
  type LoginResult,
} from '../api/auth';
import {
  listCharacters,
  createCharacter,
  deleteCharacter,
  type Character,
  type CreateCharacterBody,
} from '../api/characters';
import { useConnectionStore } from '../stores/connectionStore';
import { useSessionStore } from '../stores/sessionStore';
import { useMapStore } from '../stores/mapStore';
import { useStatusStore } from '../stores/statusStore';
import { useChatStore } from '../stores/chatStore';
import { useUserStore } from '../stores/userStore';
import { useModeStore } from '../stores/modeStore';
import { useListStore } from '../stores/listStore';
import { useEditStore } from '../stores/editStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { NotifySettings } from '../stores/settingsStore';
import { DEFAULT_NOTIFY } from '../stores/settingsStore';
import { useEagleEyeStore } from '../stores/eagleEyeStore';
import { useNoticeStore } from '../stores/noticeStore';
import { useUiStore } from '../stores/uiStore';
import { notify } from '../lib/notify';
import { applySnapshot } from '../stores/applySnapshot';
import { resetSessionState } from '../stores';

/** union を分配して各メンバから共通エンベロープキーを除いた command ペイロード型。 */
type CommandPayload = CommandRequest extends infer R
  ? R extends CommandRequest
    ? Omit<R, 'type' | 'session' | 'reqId' | 'ts'>
    : never
  : never;

/** session 欠落時の補完(A-03の単一キャラ省略ケース)。 */
function resolveSession(msgSession: string | undefined): string | null {
  if (msgSession) return msgSession;
  return useSessionStore.getState().active;
}

/** 当該 session の自キャラ名(status 優先、無ければ notice)。 */
export function selfNameOf(session: string): string | undefined {
  return (
    useStatusStore.getState().bySession[session]?.status?.name ??
    useNoticeStore.getState().bySession[session]?.name
  );
}

/**
 * 自キャラ発言のエコー(自己通知抑止対象)か判定(L4)。
 * channel='log'(通常ログ)かつ from が自キャラ名と一致する場合のみ true。
 * priv/loud/system は対象外(他者宛/他者発を含むため抑止しない)。
 */
export function isSelfEcho(
  session: string,
  channel: string,
  from: string | undefined,
): boolean {
  if (channel !== 'log') return false;
  if (!from) return false;
  const self = selfNameOf(session);
  return self !== undefined && self === from;
}

export class WsController {
  readonly client: WsClient;

  /**
   * 認証トークン(A-33)。WS auth / REST Bearer に使う。
   * localStorage(`phi_token`)へ永続化し、起動時 restore() で復帰。
   * client にも setAuthToken で渡し、接続時の WS auth ゲートを駆動する。
   * 注: token は資格情報のためログ出力しない。
   */
  private token: string | null = null;
  /** 初回 open を消費済か(2回目以降の open=再接続とみなし reattach)。 */
  private hadFirstOpen = false;
  /** 再接続フロー多重起動防止。 */
  private reattaching = false;

  constructor(client: WsClient) {
    this.client = client;
    this.wire();
  }

  private wire(): void {
    const c = this.client;

    c.onLifecycle('open', () => {
      useConnectionStore.getState().setSocketState('open');
      // 初回 open はログインフロー(Login コンポーネント)が手動で進める。
      // 2回目以降の open は再接続 → 自動で再認証+reattach(CR-5)。
      if (this.hadFirstOpen) {
        void this.reattach();
      } else {
        this.hadFirstOpen = true;
      }
    });
    c.onLifecycle('close', () =>
      useConnectionStore.getState().setSocketState('reconnecting'),
    );

    c.on('hello', (msg) => {
      useConnectionStore.getState().setProtocolVersion(msg.protocolVersion);
    });

    // A-33: WS 認証応答。ok の場合 client がゲートを解除済み(保留送信フラッシュ)。
    // 失敗(ok:false)は token 失効等 → ログアウト相当でログイン画面へ戻す。
    c.on('auth', (msg) => {
      if (msg.ok === false) {
        this.clearAuth();
        useUiStore
          .getState()
          .pushError(
            msg.error ?? { code: 'AUTH_FAILED', message: 'WS 認証に失敗しました' },
          );
        useUiStore.getState().setActiveTab(null);
      }
    });

    c.on('connection', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useConnectionStore.getState().setSessionConnection(s, msg.state);
    });

    c.onSnapshot((msg) => {
      const s = resolveSession(msg.session);
      if (s) applySnapshot(s, msg);
    });

    c.on('map', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useMapStore.getState().setMap(s, msg);
    });

    c.on('status', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useStatusStore.getState().setStatus(s, msg);
    });

    c.on('cond', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useStatusStore.getState().setCond(s, msg);
    });

    c.on('message', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useChatStore.getState().addMessage(s, msg);
      // L4: 自キャラ発言のエコー(channel='log')での自己通知を抑止。
      // 自キャラ名は status / notice から取得(snapshot/status で設定済み前提)。
      if (s && isSelfEcho(s, msg.channel, msg.from)) return;
      // F11 通知判定([05]§10)。設定は notify scope(無ければ既定)。
      const ns =
        (useSettingsStore.getState().byScope['notify'] as NotifySettings | undefined) ??
        DEFAULT_NOTIFY;
      notify({ channel: msg.channel, text: msg.text, from: msg.from }, ns);
    });

    c.on('userList', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useUserStore.getState().setUsers(s, msg);
    });

    c.on('mode', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useModeStore.getState().setMode(s, msg);
    });

    c.on('list', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useListStore.getState().setList(s, msg);
    });

    c.on('edit', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useEditStore.getState().setEdit(s, msg);
    });

    c.on('settings', (msg) => {
      useSettingsStore.getState().setScope(msg.scope, msg.value);
    });

    c.on('eagleEye', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useEagleEyeStore.getState().setEagleEye(s, msg);
    });

    // CR-3: 環境通知(世界/エリア/名前/mapset)→ noticeStore。
    c.on('notice', (msg) => {
      const s = resolveSession(msg.session);
      if (s) useNoticeStore.getState().setNotice(s, msg);
    });

    // CR-3: 世界移動の進行表示 → uiStore(FEは進行表示のみ, [07]§6.10)。
    c.on('worldTransfer', (msg) => {
      const s = resolveSession(msg.session) ?? undefined;
      if (msg.state === 'start') {
        useUiStore
          .getState()
          .setWorldTransfer({ session: s, state: 'start', server: msg.server });
      } else {
        // success/fail は一旦表示後にクリア(進行表示終了)。fail はエラーバナーも。
        useUiStore
          .getState()
          .setWorldTransfer({ session: s, state: msg.state, server: msg.server });
        if (msg.state === 'fail') {
          useUiStore.getState().pushError(
            { code: 'TRANSFER_FAILED', message: '世界移動に失敗しました' },
            s,
          );
        }
      }
    });

    // CR-3: 非相関エラー(レガシー切断等)→ エラーバナー/トースト。
    // reqId付き応答エラーは request() 側で reject されるため、ここでは
    // reqId 無し(非相関)のみ拾う。
    c.on('error', (msg) => {
      if (msg.reqId) return;
      const s = resolveSession(msg.session) ?? undefined;
      useUiStore.getState().pushError(msg.error, s);
    });
  }

  /**
   * 再接続(open)時の各アクティブセッション reattach(CR-5, A-33 token)。
   * WS auth は client が token で自動再送(open 時)するため、ここでは行わない。
   * auth ゲート中の session.open は client が保留 → auth ok 後にフラッシュされる。
   * 開いている各 session を元の opener(id|ref)で再 open(reattach)し、
   * BE が connection + snapshot を返して各 store を復元する。
   */
  private async reattach(): Promise<void> {
    if (this.reattaching) return;
    if (!this.token) return; // 未ログイン(再接続対象なし)。
    this.reattaching = true;
    try {
      const sessions = Object.values(useSessionStore.getState().sessions);
      for (const info of sessions) {
        try {
          // openSession は応答 session を再登録(BEが同一 session を払い出す想定)。
          await this.openSession(info.opener.charId, info.label);
        } catch (err) {
          useUiStore.getState().pushError(
            {
              code: 'SESSION_NOT_FOUND',
              message: `セッション再接続に失敗: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
            info.session,
          );
        }
      }
    } catch (err) {
      useUiStore.getState().pushError({
        code: 'AUTH_FAILED',
        message: `再接続時の認証に失敗: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    } finally {
      this.reattaching = false;
    }
  }

  /** 手動再接続(再接続ボタン用, CR-15 / [12]§6)。 */
  reconnectNow(): void {
    useConnectionStore.getState().setSocketState('connecting');
    this.client.reconnectNow();
  }

  // ---------- intent 送信ヘルパ ----------

  /**
   * アカウント新規登録(A-34)。POST /api/auth/register {accountId, password}。
   * 成功で {ok:true}。409(既存)等は AuthError を throw。token は発行されない
   * (登録後にログインする想定)。
   */
  async register(accountId: string, password: string): Promise<{ ok: true }> {
    return restRegister(accountId, password);
  }

  /**
   * ログイン(A-34)。POST /api/auth/login {accountId, password} で token を発行。
   * 成功で token を localStorage 保存 + client/メモリへ反映し、
   * client が WS auth ゲートを駆動できるようにする。{ok,token,isAdmin} を返す。
   * 注: password / token は資格情報のためログ出力しない。
   */
  async login(accountId: string, password: string): Promise<LoginResult> {
    useConnectionStore.getState().setSocketState('connecting');
    const result = await restLogin(accountId, password);
    // token を保持・永続化し、WS auth ゲートを駆動(A-33/A-34)。
    this.applyToken(result.token);
    return result;
  }

  /** キャラ一覧取得(GET /api/characters, Bearer)。 */
  async fetchCharacters(): Promise<Character[]> {
    return listCharacters();
  }

  /** 既存キャラの登録(POST /api/characters, Bearer)。追加後の1件 or null。 */
  async addCharacter(body: CreateCharacterBody): Promise<Character | null> {
    return createCharacter(body);
  }

  /** キャラ削除(DELETE /api/characters/{charId}, Bearer)。 */
  async removeCharacter(charId: string): Promise<void> {
    return deleteCharacter(charId);
  }

  /** token を保持・永続化し client に渡す(WS auth ゲート駆動)。 */
  private applyToken(token: string): void {
    this.token = token;
    setStoredToken(token);
    this.client.setAuthToken(token);
  }

  /** token を破棄(ログアウト/auth失効)。localStorage/client のゲートも解除。 */
  private clearAuth(): void {
    this.token = null;
    this.client.setAuthToken(null);
    clearStoredToken();
  }

  /**
   * 起動時の自動復帰(A-33)。localStorage に token があれば保持し、
   * client に渡して WS auth ゲートを有効化する。
   * 戻り値: 復帰可能(token あり)なら true。
   * 注: session.open(reattach)は WS open 後に行われる(reattach)。
   */
  restore(): boolean {
    const token = getStoredToken();
    if (!token) return false;
    this.token = token;
    this.client.setAuthToken(token);
    return true;
  }

  /**
   * ログアウト(A-33)。REST /api/auth/logout(Bearer)通知 + token クリア +
   * ローカル状態リセット → ログイン画面へ戻す。
   * WS は切断しない(再ログイン時にそのまま再 auth できるよう接続維持)。
   * client の auth ゲートは解除(setAuthToken(null))。
   */
  async logout(): Promise<void> {
    const token = this.token;
    this.clearAuth();
    // 全 session 系 store を破棄(state leak 防止)。settings/ui も別アカウント用に reset。
    resetSessionState();
    useSettingsStore.getState().reset();
    useUiStore.getState().reset(); // activeTab=null / worldTransfer / settingsOpen 等もクリア
    await restLogout(token);
  }

  /**
   * セッション開始(A-34, charId)。ログイン後のキャラ一覧から charId で接続。
   * PHI uid / host / port は BE がアカウント+charId から解決(FE は送らない)。
   * BE は session を払い出し snapshot を送る。
   * 応答(reqIdエコー)から session を取得し、sessionStore に登録・アクティブ化。
   * @param charId 接続するキャラの charId。
   * @param label タブ表示用ラベル(省略時は charId)。
   */
  async openSession(charId: string, label?: string): Promise<string> {
    if (!charId) {
      throw new Error('session.open には charId が必要');
    }
    const req: Omit<SessionOpenRequest, 'reqId'> & { reqId?: string } = {
      type: 'session.open',
      charId,
    };
    const res = (await this.client.request<SessionOpenRequest>(
      req,
    )) as ServerMessage;
    const session = res.session;
    if (!session) {
      throw new Error('session.open 応答に session 無し');
    }
    // session.open 応答は isAdmin を持つ場合がある(snapshot 経由でも可)。
    const isAdmin =
      res.type === 'session.open'
        ? (res as SessionOpenResponse).isAdmin
        : undefined;
    useSessionStore.getState().addSession({
      session,
      label: label ?? charId,
      opener: { charId },
      isAdmin,
    });
    useSessionStore.getState().setActive(session);
    return session;
  }

  /**
   * チャット送信。priv は to(userKey)必須。
   * all は全アクティブsessionへ同報(A-08: SessionManager同報相当をFEループで代替。
   *   A-14: party在籍未確認のため party単独機構は未実装、all=normal同報)。
   */
  sendChat(
    session: string,
    mode: ChatMode,
    text: string,
    to?: string,
  ): void {
    if (mode === 'priv') {
      if (!to) throw new Error('priv 発言には宛先(to)が必要');
      this.client.send({ type: 'chat', session, mode, text, to });
      return;
    }
    if (mode === 'all') {
      // 全開放session へ normal 同報(当面FE側ループ送信, A-08)
      const sessions = Object.keys(useSessionStore.getState().sessions);
      const targets = sessions.length > 0 ? sessions : [session];
      for (const s of targets) {
        this.client.send({ type: 'chat', session: s, mode: 'normal', text });
      }
      return;
    }
    this.client.send({ type: 'chat', session, mode, text });
  }

  /** 移動intent送信(F8 キーハンドラ→ここ)。dir/mode はBEがレガシー整形。 */
  sendMove(
    session: string,
    move: { dir: Dir | TurnDir; mode: MoveMode; repeat?: boolean },
  ): void {
    this.client.send({ type: 'move', session, ...move });
  }

  /** 汎用コマンド送信(name + 付随パラメータを透過)。 */
  sendCommand(session: string, payload: CommandPayload): void {
    this.client.send({ type: 'command', session, ...payload } as CommandRequest);
  }

  /** リスト選択(数値 | "all"(=-) | "cancel"(=.))。 */
  sendListSelect(session: string, value: ListSelectRequest['value']): void {
    this.client.send({ type: 'list.select', session, value });
  }

  /** s-edit/m-edit 確定(lines送出。multi終端`.`はBE整形, A)。 */
  submitEdit(session: string, mode: 'single' | 'multi', lines: string[]): void {
    this.client.send({ type: 'edit.submit', session, mode, lines });
  }

  /** 入力キャンセル(multi=`.!`, single=空送信等はBE整形)。 */
  cancelEdit(session: string): void {
    this.client.send({ type: 'edit.cancel', session });
  }

  // ---------- 設定([07]§5.7) ----------

  /**
   * 設定取得。reqIdエコー応答(settings)から value を返し settingsStore へ反映。
   * 値が無い場合は undefined。
   */
  async getSettings<T = unknown>(scope: SettingsScope): Promise<T | undefined> {
    const res = (await this.client.request<SettingsGetRequest>({
      type: 'settings.get',
      scope,
    })) as ServerMessage;
    if (res.type !== 'settings') {
      throw new Error('予期しない応答: ' + res.type);
    }
    const s = res as SettingsResponse;
    if (s.ok === false) {
      throw new Error(s.error?.message ?? '設定取得失敗');
    }
    if (s.value !== undefined) {
      useSettingsStore.getState().setScope(scope, s.value);
    }
    return s.value as T | undefined;
  }

  /** 設定保存(永続化はBE)。即座に settingsStore へ反映(楽観更新)。 */
  setSettings(scope: SettingsScope, value: unknown): void {
    useSettingsStore.getState().setScope(scope, value);
    this.client.send({ type: 'settings.set', scope, value } as SettingsSetRequest);
  }

  // ---------- 表示モード([07]§5.8, A-24) ----------

  /**
   * 表示モードをレガシーへ反映(A-24, [07]§5.8)。
   * BE が `#ex-map size=`/`#ex-map style=`/`#ex-switch eagleeye=` へ変換。
   * display 設定(mapSize/mapStyle/eagleEye)変更時に Settings から呼ぶ。
   * 指定された項目のみ送信(undefined は省略)。
   */
  sendViewSet(
    view: { mapSize?: 40 | 57; mapStyle?: 'turn' | 'solid'; eagleEye?: boolean },
    session?: string,
  ): void {
    const msg: ViewSetRequest = { type: 'view.set' };
    if (view.mapSize !== undefined) msg.mapSize = view.mapSize;
    if (view.mapStyle !== undefined) msg.mapStyle = view.mapStyle;
    if (view.eagleEye !== undefined) msg.eagleEye = view.eagleEye;
    const s = session ?? useSessionStore.getState().active ?? undefined;
    if (s) msg.session = s;
    this.client.send(msg);
  }
}
