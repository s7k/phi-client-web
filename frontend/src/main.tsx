import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { WsClient } from './ws/client';
import { WsController } from './ws/controller';

// WS 接続先: 同一オリジンの /ws(vite proxy 経由で BE へ)。
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const client = new WsClient(wsUrl);
const controller = new WsController(client);
client.connect();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App controller={controller} />
  </React.StrictMode>,
);
