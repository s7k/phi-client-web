import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { MapView, chipUrl, ITEMS_URL, clickToMove } from '../src/components/MapView';
import { WsProvider } from '../src/ws/WsContext';
import type { WsController } from '../src/ws/controller';
import { useMapStore } from '../src/stores/mapStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import type { MapEvent } from '../src/types/protocol';

beforeEach(() => {
  useMapStore.getState().reset();
  useSettingsStore.getState().reset();
});

const ctrl = { sendMove: vi.fn(), sendCommand: vi.fn() };
function renderMap(ui: React.ReactElement) {
  return render(<WsProvider controller={ctrl as unknown as WsController}>{ui}</WsProvider>);
}

function setMap(over: Partial<MapEvent> = {}) {
  const cells = Array.from({ length: 7 * 7 }, () => ({ chip: 0x20, attr: 0 }));
  const map: MapEvent = {
    type: 'map', session: 's1',
    size: 7, dir: 0, style: 'turn', mapset: 'MyMap',
    cells, chars: [], signs: [],
    ...over,
  };
  useMapStore.getState().setMap('s1', map);
}

describe('chipUrl', () => {
  it('小文字化、空はdefault', () => {
    expect(chipUrl('MyMap')).toBe('/assets/chip/mymap.png');
    expect(chipUrl('')).toBe('/assets/chip/default.png');
  });
});

describe('MapView', () => {
  it('map未設定時はplaceholder div', () => {
    const { getByTestId } = renderMap(<MapView session="s1" disableAnimation />);
    expect(getByTestId('map-empty')).toBeInTheDocument();
  });

  it('map設定時はcanvas(7x7=224px)', () => {
    setMap();
    const { getByTestId } = renderMap(<MapView session="s1" disableAnimation />);
    const canvas = getByTestId('map-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(7 * 32);
    expect(canvas.height).toBe(7 * 32);
  });

  it('5x5は160px', () => {
    setMap({ size: 5, cells: Array.from({ length: 25 }, () => ({ chip: 0x20, attr: 0 })) });
    const { getByTestId } = renderMap(<MapView session="s1" disableAnimation />);
    const canvas = getByTestId('map-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(5 * 32);
  });

  it('拡大表示(cellScale=2)は7x7=448px', () => {
    useSettingsStore.getState().setScope('display', { cellScale: 2 });
    setMap();
    const { getByTestId } = renderMap(<MapView session="s1" disableAnimation />);
    const canvas = getByTestId('map-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(7 * 64);
    expect(canvas.height).toBe(7 * 64);
  });

  it('チップURLをローダで要求', async () => {
    setMap();
    const loaded: string[] = [];
    const loader = vi.fn(async (url: string) => {
      loaded.push(url);
      return {} as HTMLImageElement;
    });
    renderMap(<MapView session="s1" loader={loader} disableAnimation />);
    await waitFor(() => expect(loaded).toContain(chipUrl('MyMap')));
  });

  it('アイテムセルありでitems.png要求', async () => {
    const cells = Array.from({ length: 49 }, () => ({ chip: 0x20, attr: 0 }));
    cells[0] = { chip: 0x20, attr: 0x10 };
    setMap({ cells });
    const loaded: string[] = [];
    const loader = vi.fn(async (url: string) => {
      loaded.push(url);
      return {} as HTMLImageElement;
    });
    renderMap(<MapView session="s1" loader={loader} disableAnimation />);
    await waitFor(() => expect(loaded).toContain(ITEMS_URL));
  });

  it('キャラのグラ候補URLを要求', async () => {
    setMap({
      chars: [{ id: 1, x: 0, y: 0, dir: 'F', name: 'M', gra: 'hero', status: 0, gigant: '#', layer: 0, default: 2 }],
    });
    const loaded: string[] = [];
    const loader = vi.fn(async (url: string) => {
      loaded.push(url);
      return {} as HTMLImageElement;
    });
    renderMap(<MapView session="s1" loader={loader} disableAnimation />);
    await waitFor(() => expect(loaded).toContain('/assets/chara/hero.png'));
    // beast(2)→t_dog、既定t_elf も候補
    expect(loaded).toContain('/assets/chara/t_dog.png');
    expect(loaded).toContain('/assets/chara/t_elf.png');
  });
});

describe('MapView 記録地図の外周', () => {
  it('座標と記録地図があれば 15x15 で描く', async () => {
    const { useNoticeStore } = await import('../src/stores/noticeStore');
    const { useAutomapStore } = await import('../src/stores/automapStore');
    useNoticeStore.getState().setNotice('s1', { world: 'SYUREN' });
    useAutomapStore.setState({ byWorld: { SYUREN: { '0,0': { chip: 0x20, attr: 0 } } } });
    setMap({ style: 'solid', pos: { x: 10, y: 10 } });
    const { getByTestId } = renderMap(<MapView session="s1" disableAnimation />);
    const canvas = getByTestId('map-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(15 * 32);
  });
});


describe('MapView マウス操作', () => {
  it('clickToMove: 縦横の大きい方。自キャラのマスは何もしない', () => {
    expect(clickToMove(0.2, -0.3)).toBeNull();
    expect(clickToMove(0.5, -2)).toBe('forward');
    expect(clickToMove(-3, 1)).toBe('strafeL');
    expect(clickToMove(2, 2)).toBe('back');
  });

  it('北固定で上をクリックすると北へ、右クリックで攻撃', () => {
    ctrl.sendMove.mockClear();
    ctrl.sendCommand.mockClear();
    setMap({ style: 'solid' });
    const { getByTestId } = renderMap(<MapView session="s1" disableAnimation />);
    const canvas = getByTestId('map-canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 224, height: 224 }) as DOMRect;
    fireEvent.click(canvas, { clientX: 112, clientY: 10 });
    expect(ctrl.sendMove).toHaveBeenCalledWith('s1', { mode: 'step', dir: 'N' });
    fireEvent.contextMenu(canvas);
    expect(ctrl.sendCommand).toHaveBeenCalledWith('s1', { name: 'hit' });
  });
});
