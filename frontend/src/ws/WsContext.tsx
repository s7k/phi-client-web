/**
 * WsController を React ツリーへ供給する Context。
 * テストでは provider に差し替えた controller を渡せる。
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { WsController } from './controller';

const WsContext = createContext<WsController | null>(null);

export function WsProvider({
  controller,
  children,
}: {
  controller: WsController;
  children: ReactNode;
}) {
  return <WsContext.Provider value={controller}>{children}</WsContext.Provider>;
}

export function useWs(): WsController {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error('WsProvider 外で useWs を使用');
  return ctx;
}
