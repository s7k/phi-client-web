import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { WsController } from '../src/ws/controller';
import { useKeyHandler } from '../src/lib/useKeyHandler';
import { useListStore } from '../src/stores/listStore';
import { useEditStore } from '../src/stores/editStore';
import { useSettingsStore } from '../src/stores/settingsStore';

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
});

describe('useKeyHandler 配線', () => {
  it('keydown(w) で sendMove(step F) を呼ぶ(wasd既定/turnモード)', () => {
    const sendMove = vi.fn();
    render(<Harness controller={makeController({ sendMove })} session="s1" />);
    fireEvent.keyDown(document, { key: 'w' });
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

  it('編集ダイアログ表示中はゲームキー無効', () => {
    const sendMove = vi.fn();
    useEditStore.getState().setEdit('s1', { mode: 'single' });
    render(<Harness controller={makeController({ sendMove })} session="s1" />);
    fireEvent.keyDown(document, { key: 'w' });
    expect(sendMove).not.toHaveBeenCalled();
  });
});
