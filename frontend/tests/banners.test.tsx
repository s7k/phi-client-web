/**
 * CR-15 / CR-3 UI コンポーネントテスト:
 * ConnectionBanner(接続帯+再接続ボタン)/ ErrorBanners / WorldTransferIndicator / WorldArea。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WsProvider } from '../src/ws/WsContext';
import type { WsController } from '../src/ws/controller';
import { ConnectionBanner } from '../src/components/ConnectionBanner';
import { ErrorBanners } from '../src/components/ErrorBanners';
import { WorldTransferIndicator } from '../src/components/WorldTransferIndicator';
import { WorldArea } from '../src/components/WorldArea';
import { useConnectionStore } from '../src/stores/connectionStore';
import { useUiStore } from '../src/stores/uiStore';
import { useNoticeStore } from '../src/stores/noticeStore';

function makeController(over: Partial<WsController> = {}): WsController {
  return { reconnectNow: vi.fn(), ...over } as unknown as WsController;
}

function renderWith(ctrl: WsController, ui: React.ReactElement) {
  return render(<WsProvider controller={ctrl}>{ui}</WsProvider>);
}

beforeEach(() => {
  useConnectionStore.getState().reset();
  useUiStore.getState().reset();
  useNoticeStore.getState().reset();
});

describe('ConnectionBanner (CR-15)', () => {
  it('open(接続済み)では帯を出さない', () => {
    useConnectionStore.getState().setSocketState('open');
    renderWith(makeController(), <ConnectionBanner />);
    expect(screen.queryByTestId('conn-banner')).toBeNull();
  });

  it('connecting で接続中の帯を表示(再接続ボタンなし)', () => {
    useConnectionStore.getState().setSocketState('connecting');
    renderWith(makeController(), <ConnectionBanner />);
    expect(screen.getByTestId('conn-banner')).toHaveTextContent('接続中');
    expect(screen.queryByText('今すぐ再接続')).toBeNull();
  });

  it('reconnecting で再接続ボタン表示 → クリックで reconnectNow', () => {
    useConnectionStore.getState().setSocketState('reconnecting');
    const reconnectNow = vi.fn();
    renderWith(makeController({ reconnectNow }), <ConnectionBanner />);
    const btn = screen.getByText('今すぐ再接続');
    fireEvent.click(btn);
    expect(reconnectNow).toHaveBeenCalledOnce();
  });
});

describe('ErrorBanners (CR-3)', () => {
  it('エラーなしでは何も出さない', () => {
    render(<ErrorBanners />);
    expect(screen.queryByTestId('error-banners')).toBeNull();
  });

  it('push したエラーを表示し、dismiss で消える', () => {
    useUiStore.getState().pushError({ code: 'LEGACY_DISCONNECTED', message: 'DM切断' });
    const { rerender } = render(<ErrorBanners />);
    expect(screen.getByText('DM切断')).toBeTruthy();
    const id = useUiStore.getState().errors[0].id;
    fireEvent.click(screen.getByLabelText('閉じる'));
    rerender(<ErrorBanners />);
    expect(useUiStore.getState().errors.find((e) => e.id === id)).toBeUndefined();
    expect(screen.queryByText('DM切断')).toBeNull();
  });
});

describe('WorldTransferIndicator (CR-3)', () => {
  it('移動なしでは非表示', () => {
    render(<WorldTransferIndicator />);
    expect(screen.queryByTestId('world-transfer')).toBeNull();
  });

  it('start で移動中インジケータ', () => {
    useUiStore.getState().setWorldTransfer({ state: 'start', server: '1.2.3.4:5000' });
    render(<WorldTransferIndicator />);
    expect(screen.getByTestId('world-transfer')).toHaveTextContent('世界移動中');
    expect(screen.getByText('1.2.3.4:5000')).toBeTruthy();
  });

  it('fail で失敗表示', () => {
    useUiStore.getState().setWorldTransfer({ state: 'fail' });
    render(<WorldTransferIndicator />);
    expect(screen.getByTestId('world-transfer')).toHaveTextContent('世界移動失敗');
  });
});

describe('WorldArea (CR-3)', () => {
  it('notice なしでは非表示', () => {
    render(<WorldArea session="s1" />);
    expect(screen.queryByTestId('world-area')).toBeNull();
  });

  it('world/area を表示', () => {
    useNoticeStore.getState().setNotice('s1', { world: 'Fantasy Island', area: '港町' });
    render(<WorldArea session="s1" />);
    expect(screen.getByTestId('world-area')).toHaveTextContent('Fantasy Island');
    expect(screen.getByTestId('world-area')).toHaveTextContent('港町');
  });
});
