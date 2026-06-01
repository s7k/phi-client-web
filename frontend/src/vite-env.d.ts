/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WS 接続先 URL の上書き(既定 `/ws`)。[12]§6, R6。 */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
