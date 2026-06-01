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
client.connect();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App controller={controller} />
  </React.StrictMode>,
);
