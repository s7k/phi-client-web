import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { WsController } from '../src/ws/controller';
import { useKeyHandler } from '../src/lib/useKeyHandler';
import { useListStore } from '../src/stores/listStore';
import { useEditStore } from '../src/stores/editStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { useMapStore } from '../src/stores/mapStore';

function makeController(over: Partial<WsController> = {}): WsController {
  return {
    sendMove: vi.fn(),
    sendCommand: vi.fn(),
    sendListSelect: vi.fn(),
    ...over,
  } as unknown as WsController;
}

function Harness({
  controller,
  session,
}: {
  controller: WsController;
  session: string | null;
}) {
  useKeyHandler(controller, session);
  return <div data-testid="harness" />;
}

beforeEach(() => {
  useListStore.getState().reset();
  useEditStore.getState().reset();
  useSettingsStore.getState().reset();
  useMapStore.getState().reset?.();
});

describe('useKeyHandler 配線', () => {
  it('keydown(8) で sendMove(step N)(numpad既定/北固定)', () => {
    // 既定=numpad、map未設定→style既定solid=北固定。8=前進=北。
    const sendMove = vi.fn();
    render(<Harness controller={makeController({ sendMove })} session="s1" />);
    fireEvent.keyDown(document, { key: '8' });
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'N', mode: 'step' });
  });

  it('北固定で u=左(step W) / o=右(step E)(左右が正しい向き)', () => {
    const sendMove = vi.fn();
    render(<Harness controller={makeController({ sendMove })} session="s1" />);
    fireEvent.keyDown(document, { key: 'u' });
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'W', mode: 'step' });
    fireEvent.keyDown(document, { key: 'o' });
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'E', mode: 'step' });
  });

  it('ライブmap.style=turn では視点固定操作(8=step F)', () => {
    const sendMove = vi.fn();
    useMapStore.getState().setMap('s1', {
      type: 'map', session: 's1', size: 5, dir: 0, style: 'turn',
      mapset: 'm', cells: [], chars: [], signs: [],
    });
    render(<Harness controller={makeController({ sendMove })} session="s1" />);
    fireEvent.keyDown(document, { key: '8' });
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'F', mode: 'step' });
  });

  it('リストモード中は数字で sendListSelect', () => {
    const sendListSelect = vi.fn();
    useListStore.getState().setList('s1', { active: true, lines: ['1: a'] });
    render(<Harness controller={makeController({ sendListSelect })} session="s1" />);
    fireEvent.keyDown(document, { key: '1' });
    expect(sendListSelect).toHaveBeenCalledWith('s1', 1);
  });

  it('F1(magic割当) で sendCommand(castMagic)', () => {
    const sendCommand = vi.fn();
    useSettingsStore.getState().setScope('keybind', { magic: { F1: 'heal' } });
    render(<Harness controller={makeController({ sendCommand })} session="s1" />);
    fireEvent.keyDown(document, { key: 'F1' });
    expect(sendCommand).toHaveBeenCalledWith('s1', { name: 'castMagic', spell: 'heal' });
  });

  it('session=null では何もしない', () => {
    const sendMove = vi.fn();
    render(<Harness controller={makeController({ sendMove })} session={null} />);
    fireEvent.keyDown(document, { key: 'w' });
    expect(sendMove).not.toHaveBeenCalled();
  });

  it('複数行編集(m-edit)モーダル中はゲームキー無効', () => {
    const sendMove = vi.fn();
    useEditStore.getState().setEdit('s1', { mode: 'multi' });
    render(<Harness controller={makeController({ sendMove })} session="s1" />);
    fireEvent.keyDown(document, { key: '8' });
    expect(sendMove).not.toHaveBeenCalled();
  });
});

describe('s-edit(single) 中もテンキー有効 / m-edit(multi)中は無効', () => {
  it('edit single active でも 8 で sendMove(step N)', () => {
    const sendMove = vi.fn();
    useEditStore.getState().setEdit('s1', { mode: 'single' } as any);
    render(<Harness controller={makeController({ sendMove })} session="s1" />);
    fireEvent.keyDown(document, { key: '8' });
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'N', mode: 'step' });
  });
  it('edit multi active 中は移動キー無効(8で送らない)', () => {
    const sendMove = vi.fn();
    useEditStore.getState().setEdit('s1', { mode: 'multi' } as any);
    render(<Harness controller={makeController({ sendMove })} session="s1" />);
    fireEvent.keyDown(document, { key: '8' });
    expect(sendMove).not.toHaveBeenCalled();
  });
});
