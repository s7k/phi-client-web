-- phi-web Web側ストア スキーマ([02]§6 + [08]§4 + [12]§1)
-- 認証(アカウント+複数キャラ, A-34)/セッション/設定/キャラグラに限定。
-- レガシーのキャラデータ本体はサーバ側管理(本DB対象外)。
-- 日付はISO8601文字列(UTC `YYYY-MM-DDTHH:MM:SSZ`)。

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------
-- 認証(アカウント+複数キャラ 再設計, A-34, [12]§1)
-- ------------------------------------------------------------------
-- 1アカウント(ログインID + Webパスワード)の下に複数キャラを保持する2層構造。
-- | 層 | 資格 |
-- | Web認証   | accounts.password_hash(argon2id) |
-- | レガシー資格 | characters.phi_uid_enc(PHI ID=uid を AEAD 暗号化保存) |
-- PHI uid は `#open <uid>` の uid 自体に6字パスワードが埋め込まれた資格情報。
-- SQLite には平文保存禁止 → PHI_SECRET_KEY で at-rest 暗号化する。
-- uid/Webパスワードはログ非出力。
CREATE TABLE IF NOT EXISTS accounts (
  account_id    TEXT PRIMARY KEY,     -- ログインID(例 wilt)
  password_hash TEXT NOT NULL,        -- argon2id(Web ログインパスワード)
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- characters: アカウント配下の複数キャラ(A-34)。各キャラ = ラベル + PHI uid
-- (資格情報, 暗号保存) + 接続先(host/port)。char_id は uuid(生PHI uid とは別)。
CREATE TABLE IF NOT EXISTS characters (
  char_id      TEXT PRIMARY KEY,      -- 内部キャラ識別子(uuid)
  account_id   TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  label        TEXT,                  -- 表示用ラベル(例「Ransaia Wilt」)
  phi_uid_enc  BLOB,                  -- 暗号化 PHI uid(#open 用, AEAD)
  host         TEXT,                  -- 接続先ホスト(省略時サーバ既定)
  port         INTEGER,               -- 接続先ポート(省略時サーバ既定)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id);

-- ゲームセッション([02]§6)
-- CR-18: ライブのゲームセッション状態は設計上インメモリ(SessionManager)で
-- 管理し、本テーブルへは永続化しない(プロセス再起動で揮発)。将来の永続化/
-- 監査用に予約。現状ライブフローからは未使用(db.py の CRUD コメント参照)。
-- char_id はレガシーの内部識別子(生PHI ID とは別)。
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  char_id      TEXT NOT NULL,        -- 内部識別子(FK 強制しない)
  state        TEXT NOT NULL,        -- attached/detached/closed
  connected_at TEXT,
  detached_at  TEXT
);

-- Web ログインセッション([12]§1.3。WS とは別。不透明乱数 token)
-- token 検証で account_id を解決し、Bearer/WS-auth の認証に使う。
CREATE TABLE IF NOT EXISTS sessions_web (
  token        TEXT PRIMARY KEY,     -- 不透明乱数(256bit)
  account_id   TEXT NOT NULL,        -- アカウント(A-34)
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- クライアント設定(map-iv/status-iv 等)。所有キー(owner)は account_id を流用。
CREATE TABLE IF NOT EXISTS settings (
  owner   TEXT NOT NULL,             -- account_id or 内部 char_id
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (owner, key)
);

-- ------------------------------------------------------------------
-- キャラグラフィック([08]§4)
-- ------------------------------------------------------------------
-- uploaded_by/updated_by は account_id(A-34)。FK は張らない。
CREATE TABLE IF NOT EXISTS chara_graphics (
  gra_name     TEXT NOT NULL,          -- グラ名(原文UTF-8, 表示用)
  gra_key      TEXT PRIMARY KEY,       -- 正規化キー = lower(gra_name)
  stored_name  TEXT NOT NULL UNIQUE,   -- 物理ファイル名(安全名)
  png_path     TEXT NOT NULL,          -- assets/chara/<stored_name>.png
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  color_key    TEXT NOT NULL DEFAULT 'teal',
  orig_sha256  TEXT NOT NULL,          -- 元BMPハッシュ(重複検出/冪等)
  uploaded_by  TEXT,                   -- account_id(A-34)
  uploaded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chara_graphics_sha ON chara_graphics(orig_sha256);

-- Index.txt 相当 + フォールバックカテゴリ
CREATE TABLE IF NOT EXISTS chara_index (
  key        TEXT PRIMARY KEY,         -- キャラ名/カテゴリ(UTF-8)
  gra_name   TEXT NOT NULL,            -- 解決先グラ名(FK強制しない)
  updated_by TEXT,                     -- account_id(A-34)
  updated_at TEXT NOT NULL
);
