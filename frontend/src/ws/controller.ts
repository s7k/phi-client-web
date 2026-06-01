/**
 * WsController — WsClient と stores の配線層。
 *
 * 責務:
 * - WS イベント(hello/connection/snapshot/map/status/cond/message/userList/mode/list/edit)
 *   を受け取り対応 store へ反映。
 * - auth / session.open / chat 等の intent 送信ヘルパ。
 * - A-02: reqId は WsClient.request が採番、BE がエコー。
 * - A-03: S→C は常に session 付与。session 欠落時はアクティブ session で補完。
 *
 * UI(コンポーネント)はこのコントローラ経由で操作し、store を購読する。
 */
import { WsClient } from './client';
import type {
  AuthRequest,
  AuthResponse,
  CharacterSummary,
  ChatMode,
  CommandRequest,
  Dir,
  ListSelectRequest,
  MoveMode,
  TurnDir,
  ServerMessage,
  SessionOpenRequest,
  SettingsGetRequest,
  SettingsResponse,
  SettingsScope,
  SettingsSetRequest,
} from '../types/protocol';
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
import { notify } from '../lib/notify';
import { applySnapshot } from '../stores/applySnapshot';

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

export class WsController {
  readonly client: WsClient;

  constructor(client: WsClient) {
    this.client = client;
    this.wire();
  }

  private wire(): void {
    const c = this.client;

    c.onLifecycle('open', () =>
      useConnectionStore.getState().setSocketState('open'),
    );
    c.onLifecycle('close', () =>
      useConnectionStore.getState().setSocketState('reconnecting'),
    );

    c.on('hello', (msg) => {
      useConnectionStore.getState().setProtocolVersion(msg.protocolVersion);
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
  }

  // ---------- intent 送信ヘルパ ----------

  /** 認証(reqIdエコー待ち)。成功でキャラ一覧を sessionStore へ格納し返す。 */
  async auth(id: string, password: string): Promise<CharacterSummary[]> {
    useConnectionStore.getState().setSocketState('connecting');
    const res = (await this.client.request<AuthRequest>({
      type: 'auth',
      id,
      password,
    })) as ServerMessage;
    if (res.type !== 'auth') {
      throw new Error('予期しない応答: ' + res.type);
    }
    const auth = res as AuthResponse;
    if (!auth.ok) {
      throw new Error(auth.error?.message ?? '認証失敗');
    }
    const chars = auth.characters ?? [];
    useSessionStore.getState().setCharacters(chars);
    return chars;
  }

  /**
   * セッション開始(キャラ選択)。BE は session を払い出し snapshot を送る。
   * 応答(reqIdエコー)から session を取得し、sessionStore に登録・アクティブ化。
   */
  async openSession(charId: string): Promise<string> {
    const res = (await this.client.request<SessionOpenRequest>({
      type: 'session.open',
      charId,
    })) as ServerMessage;
    const session = res.session;
    if (!session) {
      throw new Error('session.open 応答に session 無し');
    }
    useSessionStore.getState().addSession(session, charId);
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
}
