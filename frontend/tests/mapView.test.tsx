import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MapView, chipUrl, ITEMS_URL } from '../src/components/MapView';
import { useMapStore } from '../src/stores/mapStore';
import type { MapEvent } from '../src/types/protocol';

beforeEach(() => {
  useMapStore.getState().reset();
});

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
    const { getByTestId } = render(<MapView session="s1" disableAnimation />);
    expect(getByTestId('map-empty')).toBeInTheDocument();
  });

  it('map設定時はcanvas(7x7=224px)', () => {
    setMap();
    const { getByTestId } = render(<MapView session="s1" disableAnimation />);
    const canvas = getByTestId('map-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(7 * 32);
    expect(canvas.height).toBe(7 * 32);
  });

  it('5x5は160px', () => {
    setMap({ size: 5, cells: Array.from({ length: 25 }, () => ({ chip: 0x20, attr: 0 })) });
    const { getByTestId } = render(<MapView session="s1" disableAnimation />);
    const canvas = getByTestId('map-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(5 * 32);
  });

  it('チップURLをローダで要求', async () => {
    setMap();
    const loaded: string[] = [];
    const loader = vi.fn(async (url: string) => {
      loaded.push(url);
      return {} as HTMLImageElement;
    });
    render(<MapView session="s1" loader={loader} disableAnimation />);
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
    render(<MapView session="s1" loader={loader} disableAnimation />);
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
    render(<MapView session="s1" loader={loader} disableAnimation />);
    await waitFor(() => expect(loaded).toContain('/assets/chara/hero.png'));
    // beast(2)→t_dog、既定t_elf も候補
    expect(loaded).toContain('/assets/chara/t_dog.png');
    expect(loaded).toContain('/assets/chara/t_elf.png');
  });
});
