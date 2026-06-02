import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TouchControls } from '../src/components/TouchControls';
import { WsProvider } from '../src/ws/WsContext';
import type { WsController } from '../src/ws/controller';
import { useMapStore } from '../src/stores/mapStore';

function makeController(over: Partial<WsController> = {}): WsController {
  return {
    sendMove: vi.fn(),
    sendCommand: vi.fn(),
    ...over,
  } as unknown as WsController;
}

function renderWith(controller: WsController) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WsProvider controller={controller}>{children}</WsProvider>
  );
  return render(<TouchControls session="s1" />, { wrapper });
}

beforeEach(() => {
  useMapStore.getState().reset?.();
});

describe('TouchControls(スマホ操作パッド)', () => {
  it('北固定(既定solid): 前進=step N / 左=step W / 右=step E', () => {
    const sendMove = vi.fn();
    const { getByLabelText } = renderWith(makeController({ sendMove }));
    fireEvent.click(getByLabelText('前進'));
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'N', mode: 'step' });
    fireEvent.click(getByLabelText('左へ'));
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'W', mode: 'step' });
    fireEvent.click(getByLabelText('右へ'));
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'E', mode: 'step' });
  });

  it('回転は turn l/r(北固定でも回転は共通)', () => {
    const sendMove = vi.fn();
    const { getByLabelText } = renderWith(makeController({ sendMove }));
    fireEvent.click(getByLabelText('左回転'));
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'l', mode: 'turn' });
    fireEvent.click(getByLabelText('右回転'));
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'r', mode: 'turn' });
  });

  it('turnモード(map.style=turn): 前進=step F / 左=strafe L', () => {
    const sendMove = vi.fn();
    useMapStore.getState().setMap('s1', {
      type: 'map', session: 's1', size: 5, dir: 0, style: 'turn',
      mapset: 'm', cells: [], chars: [], signs: [],
    });
    const { getByLabelText } = renderWith(makeController({ sendMove }));
    fireEvent.click(getByLabelText('前進'));
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'F', mode: 'step' });
    fireEvent.click(getByLabelText('左へ'));
    expect(sendMove).toHaveBeenCalledWith('s1', { dir: 'L', mode: 'strafe' });
  });

  it('攻撃ボタンで sendCommand(hit)', () => {
    const sendCommand = vi.fn();
    const { getByLabelText } = renderWith(makeController({ sendCommand }));
    fireEvent.click(getByLabelText('攻撃'));
    expect(sendCommand).toHaveBeenCalledWith('s1', { name: 'hit' });
  });
});
