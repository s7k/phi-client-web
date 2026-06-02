import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { WsClient } from './ws/client';
import { WsController } from './ws/controller';
import { resolveWsUrl } from './ws/wsUrl';

// WS 接続先: 既定は相対 /ws(同一オリジン → vite proxy/リバースプロキシ経由で BE へ)。
// env VITE_WS_URL で上書き可([12]§6, R6)。
const wsUrl = resolveWsUrl(import.meta.env.VITE_WS_URL);
const client = new WsClient(wsUrl);
const controller = new WsController(client);
// A-33: 起動時 localStorage に token があれば WS auth ゲートを有効化(自動復帰)。
// connect 前に呼ぶことで、最初の open で auth が送られる。
controller.restore();
client.connect();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App controller={controller} />
  </React.StrictMode>,
);
