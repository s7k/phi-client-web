/**
 * BE ⇔ FE WebSocket プロトコル型定義（契約 = docs/07-ws-protocol.md）。
 *
 * - 全メッセージは共通エンベロープ + type固有ペイロードのフラット展開。
 * - C→S(意図/要求) と S→C(イベント/応答) を discriminated union で定義。
 * - `type` フィールドで narrow する。
 * - 本仕様 = protocolVersion 1 (v1)。
 */

// ============================================================
// 共通エンベロープ・基本型
// ============================================================

/** 全メッセージ共通の予約キー。ペイロードはこれらと衝突させない([07]§2)。 */
export interface Envelope {
  type: string;
  /** キャラセッションID。単一キャラ時は省略可([07]§2)。 */
  session?: string;
  /** 要求/応答の相関ID。要求側が採番([07]§2)。 */
  reqId?: string;
  /** 送信側UNIX時刻(ms)。ログ/遅延計測用([07]§2)。 */
  ts?: number;
}

/** reqId付き要求への応答が持つフィールド([07]§2, §9)。 */
export interface ResponseFields {
  ok: boolean;
  error?: ProtocolError;
}

/** エラー詳細([07]§9)。 */
export interface ProtocolError {
  code: ErrorCode;
  message: string;
  /** 登録 reject 等で欠陥フィールドを列挙する場合([12]§2.3)。 */
  fields?: string[];
}

/** エラーコード([07]§9)。 */
export type ErrorCode =
  | 'AUTH_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'LEGACY_DISCONNECTED'
  | 'TRANSFER_FAILED'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'INTERNAL'
  | (string & {}); // 前方互換: 未知コードも許容

/** 方角([07]§3.3)。N/E/S/W(絶対) or B/R/F/L(キャラ相対: Back/Right/Front/Left)。 */
export type CompassDir = 'N' | 'E' | 'S' | 'W';
export type RelativeDir = 'B' | 'R' | 'F' | 'L';
export type Dir = CompassDir | RelativeDir;

/** 回転方向(DEVLOG A-05/06/07: `mode:"turn"` + `dir:"l|r|b"` で turn l/r/b)。 */
export type TurnDir = 'l' | 'r' | 'b';

/** レガシー接続状態([07]§6.1)。 */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'detached'
  | 'closed';

// ============================================================
// C→S メッセージ（FE→BE: 意図・要求）[07]§5
// ============================================================

// --- 5.1 接続・セッション ---

export interface AuthRequest extends Envelope {
  type: 'auth';
  /** reqId必須([07]§5.1)。 */
  reqId: string;
  id: string;
  password: string;
}

export interface SessionOpenRequest extends Envelope {
  type: 'session.open';
  reqId?: string;
  charId: string;
}

export interface SessionCloseRequest extends Envelope {
  type: 'session.close';
}

// --- 5.2 移動 ---

export type MoveMode = 'step' | 'turn' | 'strafe';

export interface MoveRequest extends Envelope {
  type: 'move';
  /** step/strafe は Dir(絶対/相対)、turn は TurnDir(l/r/b)(A-05/06/07)。 */
  dir: Dir | TurnDir;
  mode: MoveMode;
  /** 連続移動([07]§5.2)。 */
  repeat?: boolean;
}

// --- 5.3 チャット ---

export type ChatMode = 'normal' | 'loud' | 'party' | 'all' | 'priv';

interface ChatRequestBase extends Envelope {
  type: 'chat';
  mode: ChatMode;
  text: string;
}

/** 通常/loud/party/all 発言。 */
export interface ChatPublicRequest extends ChatRequestBase {
  mode: 'normal' | 'loud' | 'party' | 'all';
}

/** priv(個人宛)発言。`to` は userList の key([07]§5.3, §6.6)。 */
export interface ChatPrivRequest extends ChatRequestBase {
  mode: 'priv';
  to: string;
}

export type ChatRequest = ChatPublicRequest | ChatPrivRequest;

// --- 5.4 汎用コマンド ---

/** command.name の値([07]§5.4)。 */
export type CommandName =
  | 'hit'
  | 'pay'
  | 'equip'
  | 'unequip'
  | 'get'
  | 'put'
  | 'use'
  | 'sort'
  | 'read'
  | 'write'
  | 'board'
  | 'castMagic'
  | 'summon'
  | 'shop'
  | 'raw';

interface CommandRequestBase extends Envelope {
  type: 'command';
  name: CommandName;
}

export interface CommandSimpleRequest extends CommandRequestBase {
  name:
    | 'hit'
    | 'equip'
    | 'unequip'
    | 'get'
    | 'put'
    | 'use'
    | 'sort'
    | 'read'
    | 'write'
    | 'board';
}

export interface CommandPayRequest extends CommandRequestBase {
  name: 'pay';
  /** 0 を含む([07]§5.4)。 */
  amount: number;
}

export interface CommandCastMagicRequest extends CommandRequestBase {
  name: 'castMagic';
  spell: string;
}

export interface CommandSummonRequest extends CommandRequestBase {
  name: 'summon';
  action: 'appear' | 'disappear';
  creature: string;
}

export interface CommandShopRequest extends CommandRequestBase {
  name: 'shop';
  action: 'buy' | 'sell' | 'shop';
}

/** エスケープハッチ。`text` を素通し送信([07]§5.4, レート制限対象§10)。 */
export interface CommandRawRequest extends CommandRequestBase {
  name: 'raw';
  text: string;
}

export type CommandRequest =
  | CommandSimpleRequest
  | CommandPayRequest
  | CommandCastMagicRequest
  | CommandSummonRequest
  | CommandShopRequest
  | CommandRawRequest;

// --- 5.5 リスト選択 ---

export interface ListSelectRequest extends Envelope {
  type: 'list.select';
  /** 数値(項目番号) | "all"(=`-`) | "cancel"(=`.`)([07]§5.5)。 */
  value: number | 'all' | 'cancel';
}

// --- 5.6 入力(s-edit/m-edit) ---

export interface EditSubmitRequest extends Envelope {
  type: 'edit.submit';
  mode: 'single' | 'multi';
  lines: string[];
}

export interface EditCancelRequest extends Envelope {
  type: 'edit.cancel';
}

// --- 5.7 設定 ---

export type SettingsScope =
  | 'keybind'
  | 'notify'
  | 'display'
  | 'intervals'
  | (string & {});

export interface SettingsGetRequest extends Envelope {
  type: 'settings.get';
  reqId: string;
  scope: SettingsScope;
}

export interface SettingsSetRequest extends Envelope {
  type: 'settings.set';
  reqId?: string;
  scope: SettingsScope;
  value: unknown;
}

// --- 5.8 表示モード要求 ---

export interface ViewSetRequest extends Envelope {
  type: 'view.set';
  mapSize?: 40 | 57;
  mapStyle?: 'turn' | 'solid';
  eagleEye?: boolean;
}

export interface MapRequestRequest extends Envelope {
  type: 'map.request';
}

// --- 5.9 ハートビート(任意) ---

export interface PingRequest extends Envelope {
  type: 'ping';
  nonce: string;
}

/** 全 C→S メッセージの discriminated union。 */
export type ClientMessage =
  | AuthRequest
  | SessionOpenRequest
  | SessionCloseRequest
  | MoveRequest
  | ChatRequest
  | CommandRequest
  | ListSelectRequest
  | EditSubmitRequest
  | EditCancelRequest
  | SettingsGetRequest
  | SettingsSetRequest
  | ViewSetRequest
  | MapRequestRequest
  | PingRequest;

// ============================================================
// S→C メッセージ（BE→FE: イベント・応答）[07]§6
// ============================================================

// --- 6.1 ハンドシェイク・接続 ---

export interface HelloEvent extends Envelope {
  type: 'hello';
  protocolVersion: number;
  serverTime: number;
}

/** auth応答([07]§6.1)。reqId相関。 */
export interface AuthResponse extends Envelope, ResponseFields {
  type: 'auth';
  characters?: CharacterSummary[];
}

export interface CharacterSummary {
  charId: string;
  name: string;
  lastServer?: string;
}

export interface ConnectionEvent extends Envelope {
  type: 'connection';
  state: ConnectionState;
  reason?: string;
}

/** 再アタッチ時の一括状態([07]§4.2, §6.1)。FEが全置換で画面復元。 */
export interface SnapshotEvent extends Envelope {
  type: 'snapshot';
  map?: MapEventPayload;
  status?: StatusEventPayload;
  cond?: CondEventPayload;
  userList?: UserListEventPayload;
  mode?: ModeEventPayload;
  notice?: NoticeEventPayload;
  /** アクティブなリスト対話状態(DEVLOG A-04, [07]§6.1)。 */
  list?: ListEventPayload;
  /** アクティブな入力対話状態(DEVLOG A-04, [07]§6.1)。 */
  edit?: EditEventPayload;
}

// --- 6.2 マップ ---

/** マップ1セル。chip/attr は 0-255([07]§6.2)。 */
export interface MapCell {
  chip: number;
  attr: number;
}

/** マップ上のキャラ/オブジェクト([07]§6.2)。 */
export interface MapChar {
  id: number;
  x: number;
  y: number;
  /** キャラ向き。文字 or 数値([07]§3.3, §6.2)。 */
  dir: Dir | number;
  name: string;
  /** グラ名(拡張子なし、Index.txtで解決)。 */
  gra: string;
  status: number;
  /** "#"=通常 / "*"=巨大([07]§6.2)。 */
  gigant: string;
  layer: number;
  /** typeコード(#m57 O末尾)。グラ フォールバックに使用([09])。 */
  default: number;
  /**
   * 巨大キャラ拡大描画パラメータ(#ex-obj)。BEがR7で付与(任意)。
   * w/h=拡大後の描画サイズ(px)、z=垂直オフセット(px)。
   * map_widget.py の magnify=(mx,my,mz) に対応(FE-Q15)。
   */
  magnify?: { w: number; h: number; z: number };
}

/** 看板(#…B)([07]§6.2)。 */
export interface MapSign {
  x: number;
  y: number;
  title: string;
}

interface MapEventPayload {
  /** 7(=m57,7x7) | 5(=5x5)。 */
  size: number;
  /** 自キャラ方角(0-7 or 文字)。turnモード時の上方向。 */
  dir: number | Dir;
  style: 'turn' | 'solid';
  /** チップセット名(#mapset)。 */
  mapset: string;
  /** size*size 要素、行優先(index=y*size+x)。 */
  cells: MapCell[];
  chars: MapChar[];
  signs?: MapSign[];
}

export interface MapEvent extends Envelope, MapEventPayload {
  type: 'map';
}

// --- 6.3 ステータス ---

interface StatusEventPayload {
  name: string;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  exp: number;
  gp: number;
  /** Fire/Water/Wind/... 属性値(#status の F:W:M:C)。 */
  f: number;
  w: number;
  m: number;
  c: number;
}

export interface StatusEvent extends Envelope, StatusEventPayload {
  type: 'status';
}

// --- 6.4 状態異常 ---

interface CondEventPayload {
  poison: boolean;
  palsy: boolean;
  panic: boolean;
  confuse: boolean;
  berserk: boolean;
  silence: boolean;
  blind: boolean;
}

export interface CondEvent extends Envelope, CondEventPayload {
  type: 'cond';
}

// --- 6.5 メッセージ・ログ ---

export type MessageChannel = 'log' | 'priv' | 'loud' | 'system';

export interface MessageEvent extends Envelope {
  type: 'message';
  channel: MessageChannel;
  /** session毎の単調増加連番(重複抑止用, A-11, [07]§6.5)。 */
  seq?: number;
  /** 発言者(なければ省略)。 */
  from?: string;
  /** UTF-8(SJISから変換済)。マークアップ含む生テキスト。 */
  text: string;
  /** color=... 等のマークアップ([05]§10,13)を含むか。 */
  markup?: boolean;
}

// --- 6.6 ユーザ一覧 ---

export interface UserListEntry {
  /** priv宛先に使う key。BE採番(#user番号を隠蔽)([07]§6.6)。 */
  key: string;
  name: string;
}

interface UserListEventPayload {
  users: UserListEntry[];
}

export interface UserListEvent extends Envelope, UserListEventPayload {
  type: 'userList';
}

// --- 6.7 リスト ---

interface ListEventPayload {
  active: boolean;
  /** active=true の時の項目行。 */
  lines?: string[];
}

export interface ListEvent extends Envelope, ListEventPayload {
  type: 'list';
}

// --- 6.8 入力要求 ---

interface EditEventPayload {
  /** "single"|"multi" 入力要求。"end"(#.) でクローズ([07]§6.8)。 */
  mode: 'single' | 'multi' | 'end';
}

export interface EditEvent extends Envelope, EditEventPayload {
  type: 'edit';
}

// --- 6.9 モードフラグ ---

interface ModeEventPayload {
  attack: boolean;
  magic: boolean;
  list: boolean;
  more: boolean;
}

export interface ModeEvent extends Envelope, Partial<ModeEventPayload> {
  type: 'mode';
}

// --- 6.10 世界移動 ---

export interface WorldTransferEvent extends Envelope {
  type: 'worldTransfer';
  state: 'start' | 'success' | 'fail';
  server?: string;
}

// --- 6.11 EagleEye ---

export interface EagleEyeEvent extends Envelope {
  type: 'eagleEye';
  width: number;
  height: number;
  self: { x: number; y: number };
  /** width*height、行優先。 */
  cells: MapCell[];
}

// --- 6.12 環境通知 ---

interface NoticeEventPayload {
  world?: string;
  area?: string;
  name?: string;
  mapset?: string;
}

export interface NoticeEvent extends Envelope, NoticeEventPayload {
  type: 'notice';
}

// --- 6.13 設定応答 ---

export interface SettingsResponse extends Envelope, ResponseFields {
  type: 'settings';
  scope: SettingsScope;
  value?: unknown;
}

// --- 6.14 ハートビート応答 ---

export interface PongEvent extends Envelope {
  type: 'pong';
  nonce: string;
  serverTime: number;
}

// --- 6/9 汎用エラー(非相関) ---

export interface ErrorEvent extends Envelope {
  type: 'error';
  error: ProtocolError;
}

/** 全 S→C メッセージの discriminated union。 */
export type ServerMessage =
  | HelloEvent
  | AuthResponse
  | ConnectionEvent
  | SnapshotEvent
  | MapEvent
  | StatusEvent
  | CondEvent
  | MessageEvent
  | UserListEvent
  | ListEvent
  | EditEvent
  | ModeEvent
  | WorldTransferEvent
  | EagleEyeEvent
  | NoticeEvent
  | SettingsResponse
  | PongEvent
  | ErrorEvent;

/** S→C の type 文字列リテラル union。 */
export type ServerMessageType = ServerMessage['type'];

/** 指定 type の S→C メッセージ型を取り出すヘルパ。 */
export type ServerMessageOf<T extends ServerMessageType> = Extract<
  ServerMessage,
  { type: T }
>;
