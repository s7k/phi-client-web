-- phi-web Web側ストア スキーマ([02]§6 + [08]§4 + [12]§1.4)
-- 認証/セッション/設定/IDマッピング/キャラグラに限定。
-- レガシーのキャラデータ本体はサーバ側管理(本DB対象外)。
-- 日付はISO8601文字列(UTC `YYYY-MM-DDTHH:MM:SSZ`)。

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------
-- 認証([02]§6 + [12]§1.4 追補)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,      -- ログインID
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0  -- 管理者フラグ(キャラグラ変更系の権限)
);

-- characters: [02]§6 + [12]§1.4(legacy_uid_enc / legacy_host 追加)
CREATE TABLE IF NOT EXISTS characters (
  char_id        TEXT PRIMARY KEY,     -- #open に渡すキャラクターID
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  display_name   TEXT,
  last_server    TEXT,                 -- 世界移動対応(将来)
  legacy_uid_enc BLOB,                 -- 暗号化uid(#open用, AEAD)
  legacy_host    TEXT,                 -- 接続先(last_serverと統合可)
  updated_at     TEXT NOT NULL
);

-- ゲームセッション([02]§6)
-- CR-18: ライブのゲームセッション状態は設計上インメモリ(SessionManager)で
-- 管理し、本テーブルへは永続化しない(プロセス再起動で揮発)。将来の永続化/
-- 監査用に予約。現状ライブフローからは未使用(db.py の CRUD コメント参照)。
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  char_id      TEXT NOT NULL REFERENCES characters(char_id),
  state        TEXT NOT NULL,          -- attached/detached/closed
  connected_at TEXT,
  detached_at  TEXT
);

-- Webログインセッション([12]§1.4。WSとは別。不透明乱数ID)
CREATE TABLE IF NOT EXISTS sessions_web (
  session_id   TEXT PRIMARY KEY,       -- 不透明乱数(128bit+)
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- クライアント設定(map-iv/status-iv 等)
CREATE TABLE IF NOT EXISTS settings (
  char_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (char_id, key)
);

-- ------------------------------------------------------------------
-- キャラグラフィック([08]§4)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chara_graphics (
  gra_name     TEXT NOT NULL,          -- グラ名(原文UTF-8, 表示用)
  gra_key      TEXT PRIMARY KEY,       -- 正規化キー = lower(gra_name)
  stored_name  TEXT NOT NULL UNIQUE,   -- 物理ファイル名(安全名)
  png_path     TEXT NOT NULL,          -- assets/chara/<stored_name>.png
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  color_key    TEXT NOT NULL DEFAULT 'teal',
  orig_sha256  TEXT NOT NULL,          -- 元BMPハッシュ(重複検出/冪等)
  uploaded_by  TEXT REFERENCES accounts(id),
  uploaded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chara_graphics_sha ON chara_graphics(orig_sha256);

-- Index.txt 相当 + フォールバックカテゴリ
CREATE TABLE IF NOT EXISTS chara_index (
  key        TEXT PRIMARY KEY,         -- キャラ名/カテゴリ(UTF-8)
  gra_name   TEXT NOT NULL,            -- 解決先グラ名(FK強制しない)
  updated_by TEXT REFERENCES accounts(id),
  updated_at TEXT NOT NULL
);
