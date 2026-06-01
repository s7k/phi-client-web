import { describe, it, expect, beforeEach } from 'vitest';
import { useListStore } from '../src/stores/listStore';
import { useEditStore } from '../src/stores/editStore';
import { useUserStore } from '../src/stores/userStore';
import { useModeStore } from '../src/stores/modeStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { useChatStore } from '../src/stores/chatStore';
import { useMapStore } from '../src/stores/mapStore';
import { useStatusStore } from '../src/stores/statusStore';
import { applySnapshot } from '../src/stores/applySnapshot';
import type { MessageEvent, SnapshotEvent } from '../src/types/protocol';

const S = 'char1';

beforeEach(() => {
  useListStore.getState().reset();
  useEditStore.getState().reset();
  useUserStore.getState().reset();
  useModeStore.getState().reset();
  useUiStore.getState().reset();
  useSettingsStore.getState().reset();
  useChatStore.getState().reset();
  useMapStore.getState().reset();
  useStatusStore.getState().reset();
});

describe('listStore', () => {
  it('active=true で項目保持、active=false でクリア', () => {
    useListStore.getState().setList(S, { active: true, lines: ['a', 'b'] });
    expect(useListStore.getState().bySession[S].lines).toEqual(['a', 'b']);
    useListStore.getState().setList(S, { active: false });
    expect(useListStore.getState().bySession[S].active).toBe(false);
    expect(useListStore.getState().bySession[S].lines).toEqual([]);
  });
});

describe('editStore', () => {
  it('single/multi で active、end でクローズ', () => {
    useEditStore.getState().setEdit(S, { mode: 'single' });
    expect(useEditStore.getState().bySession[S]).toEqual({
      active: true,
      mode: 'single',
    });
    useEditStore.getState().setEdit(S, { mode: 'end' });
    expect(useEditStore.getState().bySession[S]).toEqual({
      active: false,
      mode: null,
    });
  });
});

describe('userStore', () => {
  it('userList を session別に全置換', () => {
    useUserStore.getState().setUsers(S, { users: [{ key: 'u1', name: 'A' }] });
    expect(useUserStore.getState().bySession[S]).toHaveLength(1);
    useUserStore.getState().setUsers(S, { users: [] });
    expect(useUserStore.getState().bySession[S]).toHaveLength(0);
  });
});

describe('modeStore', () => {
  it('mode は部分更新(未指定は温存)', () => {
    useModeStore.getState().setMode(S, { attack: true, magic: true });
    useModeStore.getState().setMode(S, { magic: false });
    expect(useModeStore.getState().bySession[S]).toEqual({
      attack: true,
      magic: false,
      list: false,
      more: false,
    });
  });
});

describe('uiStore', () => {
  it('chatMode / privTo / confirm', () => {
    const u = useUiStore.getState();
    u.setChatMode('priv');
    u.setPrivTo('u1');
    expect(useUiStore.getState().chatMode).toBe('priv');
    expect(useUiStore.getState().privTo).toBe('u1');

    let fired = false;
    u.openConfirm({ message: 'x', onConfirm: () => (fired = true) });
    expect(useUiStore.getState().confirm).not.toBeNull();
    useUiStore.getState().confirm!.onConfirm();
    expect(fired).toBe(true);
    useUiStore.getState().closeConfirm();
    expect(useUiStore.getState().confirm).toBeNull();
  });
});

describe('settingsStore', () => {
  it('scope別 set/get', () => {
    useSettingsStore.getState().setScope('display', { theme: 'dark' });
    expect(useSettingsStore.getState().getScope('display')).toEqual({
      theme: 'dark',
    });
  });
});

describe('chatStore 重複抑止', () => {
  it('seq一致は重複として無視', () => {
    const mk = (text: string, seq: number): MessageEvent & { seq: number } => ({
      type: 'message',
      session: S,
      channel: 'log',
      text,
      seq,
    });
    useChatStore.getState().addMessage(S, mk('a', 1));
    useChatStore.getState().addMessage(S, mk('a', 1)); // 重複seq
    useChatStore.getState().addMessage(S, mk('b', 2));
    expect(useChatStore.getState().bySession[S].map((m) => m.text)).toEqual([
      'a',
      'b',
    ]);
  });

  it('seq無しは直前と内容一致なら無視', () => {
    const mk = (text: string): MessageEvent => ({
      type: 'message',
      session: S,
      channel: 'log',
      ts: 100,
      text,
    });
    useChatStore.getState().addMessage(S, mk('hi'));
    useChatStore.getState().addMessage(S, mk('hi')); // 直前と同一
    expect(useChatStore.getState().bySession[S]).toHaveLength(1);
  });
});

describe('applySnapshot 拡張配線', () => {
  it('userList/mode/list/edit を全置換配線', () => {
    const snap: SnapshotEvent = {
      type: 'snapshot',
      session: S,
      userList: { users: [{ key: 'u1', name: 'A' }] },
      mode: { attack: true, magic: false, list: false, more: false },
      list: { active: true, lines: ['x'] },
      edit: { mode: 'multi' },
    };
    applySnapshot(S, snap);
    expect(useUserStore.getState().bySession[S]).toHaveLength(1);
    expect(useModeStore.getState().bySession[S].attack).toBe(true);
    expect(useListStore.getState().bySession[S].lines).toEqual(['x']);
    expect(useEditStore.getState().bySession[S]).toEqual({
      active: true,
      mode: 'multi',
    });
  });
});
