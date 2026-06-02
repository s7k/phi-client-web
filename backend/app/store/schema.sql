-- phi-web Web側ストア スキーマ([02]§6 + [08]§4 + [12]§1.4)
-- 認証(ID-only)/セッション/設定/IDマッピング/キャラグラに限定。
-- レガシーのキャラデータ本体はサーバ側管理(本DB対象外)。
-- 日付はISO8601文字列(UTC `YYYY-MM-DDTHH:MM:SSZ`)。

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------
-- 認証(ID-only 再設計, [12]§1)
-- ------------------------------------------------------------------
-- PHI プレイヤーは ID のみで識別され、`#open <uid>` の uid 自体に6字
-- パスワードが埋め込まれた**資格情報**。よって別 Web パスワードは廃止。
-- ID=資格情報として扱い、SQLite には**暗号保存**(at-rest)する。
--   id_key  = sha256(平文ID)          ← 検索/PK(生ID非保持)
--   id_enc  = 平文IDを PHI_SECRET_KEY で AEAD 暗号化した BLOB(復号で #open)
--   is_admin= 管理者フラグ(キャラグラ変更系の権限)
CREATE TABLE IF NOT EXISTS saved_ids (
  id_key       TEXT PRIMARY KEY,     -- sha256(平文ID) 16進
  id_enc       BLOB NOT NULL,        -- 暗号化済み平文ID(AEAD)
  label        TEXT,                 -- 表示用ラベル(任意, 生ID非公開のUI用)
  is_admin     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

-- characters: レガシー登録(B15 register)/世界移動(B13)用の内部キャラ表。
-- ID-only 再設計で Web 認証からは切り離したが、登録代行で生成した内部 charId と
-- 暗号化 uid・接続先を保持する用途で存続(account_id は id_key を流用, FK なし)。
CREATE TABLE IF NOT EXISTS characters (
  char_id        TEXT PRIMARY KEY,     -- 内部キャラ識別子(生PHI ID とは別)
  account_id     TEXT,                 -- id_key(生ID非保持)。FK は張らない
  display_name   TEXT,
  last_server    TEXT,                 -- 世界移動対応
  legacy_uid_enc BLOB,                 -- 暗号化uid(#open用, AEAD)
  legacy_host    TEXT,                 -- 接続先(last_serverと統合可)
  updated_at     TEXT NOT NULL
);

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

-- Web ログインセッション([12]§1.4。WS とは別。不透明乱数 ID)
--   id_key  = sha256(平文ID)     ← saved_ids/admin 判定キー
--   id_enc  = セッション内 #open 用の暗号化済み平文ID
CREATE TABLE IF NOT EXISTS sessions_web (
  token        TEXT PRIMARY KEY,     -- 不透明乱数(256bit)
  id_key       TEXT NOT NULL,        -- sha256(平文ID)
  id_enc       BLOB NOT NULL,        -- 暗号化済み平文ID(#open 用)
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- クライアント設定(map-iv/status-iv 等)。所有キー(owner)は id_key を流用。
CREATE TABLE IF NOT EXISTS settings (
  owner   TEXT NOT NULL,             -- id_key or 内部 char_id
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (owner, key)
);

-- ------------------------------------------------------------------
-- キャラグラフィック([08]§4)
-- ------------------------------------------------------------------
-- uploaded_by/updated_by は id_key(生ID非保持)。FK は張らない。
CREATE TABLE IF NOT EXISTS chara_graphics (
  gra_name     TEXT NOT NULL,          -- グラ名(原文UTF-8, 表示用)
  gra_key      TEXT PRIMARY KEY,       -- 正規化キー = lower(gra_name)
  stored_name  TEXT NOT NULL UNIQUE,   -- 物理ファイル名(安全名)
  png_path     TEXT NOT NULL,          -- assets/chara/<stored_name>.png
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  color_key    TEXT NOT NULL DEFAULT 'teal',
  orig_sha256  TEXT NOT NULL,          -- 元BMPハッシュ(重複検出/冪等)
  uploaded_by  TEXT,                   -- id_key(生ID非保持)
  uploaded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chara_graphics_sha ON chara_graphics(orig_sha256);

-- Index.txt 相当 + フォールバックカテゴリ
CREATE TABLE IF NOT EXISTS chara_index (
  key        TEXT PRIMARY KEY,         -- キャラ名/カテゴリ(UTF-8)
  gra_name   TEXT NOT NULL,            -- 解決先グラ名(FK強制しない)
  updated_by TEXT,                     -- id_key(生ID非保持)
  updated_at TEXT NOT NULL
);
