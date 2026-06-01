import { describe, it, expect, beforeEach } from 'vitest';
import { useConnectionStore } from '../src/stores/connectionStore';
import { useSessionStore } from '../src/stores/sessionStore';
import { useMapStore } from '../src/stores/mapStore';
import { useStatusStore } from '../src/stores/statusStore';
import { useChatStore } from '../src/stores/chatStore';
import { applySnapshot } from '../src/stores/applySnapshot';
import type {
  MapEvent,
  MessageEvent,
  SnapshotEvent,
  StatusEvent,
  CondEvent,
} from '../src/types/protocol';

const S = 'char1';

function resetAll() {
  useConnectionStore.getState().reset();
  useSessionStore.getState().reset();
  useMapStore.getState().reset();
  useStatusStore.getState().reset();
  useChatStore.getState().reset();
}

beforeEach(resetAll);

describe('connectionStore', () => {
  it('WS全体状態とsession別state', () => {
    const c = useConnectionStore.getState();
    c.setSocketState('connecting');
    expect(useConnectionStore.getState().socketState).toBe('connecting');

    c.setSessionConnection(S, 'connected');
    expect(useConnectionStore.getState().sessions[S]).toBe('connected');
    c.setSessionConnection(S, 'detached');
    expect(useConnectionStore.getState().sessions[S]).toBe('detached');
  });
});

describe('sessionStore', () => {
  it('キャラ一覧・アクティブsession', () => {
    const s = useSessionStore.getState();
    s.setCharacters([
      { charId: 'c1', name: 'A' },
      { charId: 'c2', name: 'B' },
    ]);
    expect(useSessionStore.getState().characters).toHaveLength(2);

    s.addSession(S, 'c1');
    s.setActive(S);
    expect(useSessionStore.getState().active).toBe(S);
    expect(useSessionStore.getState().sessions[S].charId).toBe('c1');
  });
});

describe('statusStore', () => {
  it('session別 status/cond を保持', () => {
    const st: StatusEvent = {
      type: 'status', session: S, name: 'X',
      hp: 100, maxHp: 200, mp: 10, maxMp: 20,
      exp: 5, gp: 9, f: 1, w: 2, m: 3, c: 4,
    };
    useStatusStore.getState().setStatus(S, st);
    expect(useStatusStore.getState().bySession[S].status?.hp).toBe(100);

    const cond: CondEvent = {
      type: 'cond', session: S,
      poison: true, palsy: false, panic: false, confuse: false,
      berserk: false, silence: false, blind: false,
    };
    useStatusStore.getState().setCond(S, cond);
    expect(useStatusStore.getState().bySession[S].cond?.poison).toBe(true);
  });

  it('session別に独立', () => {
    const mk = (s: string, hp: number): StatusEvent => ({
      type: 'status', session: s, name: 'X', hp, maxHp: hp, mp: 0, maxMp: 0,
      exp: 0, gp: 0, f: 0, w: 0, m: 0, c: 0,
    });
    useStatusStore.getState().setStatus('a', mk('a', 1));
    useStatusStore.getState().setStatus('b', mk('b', 2));
    expect(useStatusStore.getState().bySession['a'].status?.hp).toBe(1);
    expect(useStatusStore.getState().bySession['b'].status?.hp).toBe(2);
  });
});

describe('mapStore', () => {
  it('map を session別に全置換', () => {
    const m: MapEvent = {
      type: 'map', session: S, size: 5, dir: 0, style: 'solid',
      mapset: 'm1', cells: [{ chip: 1, attr: 0 }], chars: [], signs: [],
    };
    useMapStore.getState().setMap(S, m);
    expect(useMapStore.getState().bySession[S]?.size).toBe(5);
    expect(useMapStore.getState().bySession[S]?.cells).toHaveLength(1);

    // 全置換(差分でなく上書き)
    useMapStore.getState().setMap(S, { ...m, size: 7, cells: [] });
    expect(useMapStore.getState().bySession[S]?.size).toBe(7);
    expect(useMapStore.getState().bySession[S]?.cells).toHaveLength(0);
  });
});

describe('chatStore', () => {
  it('message を追記。リングバッファ上限', () => {
    const mk = (text: string): MessageEvent => ({
      type: 'message', session: S, channel: 'log', text,
    });
    useChatStore.getState().addMessage(S, mk('a'));
    useChatStore.getState().addMessage(S, mk('b'));
    expect(useChatStore.getState().bySession[S].map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('上限超過で古いものを破棄(リングバッファ)', () => {
    const cap = useChatStore.getState().capacity;
    for (let i = 0; i < cap + 5; i++) {
      useChatStore.getState().addMessage(S, {
        type: 'message', session: S, channel: 'log', text: String(i),
      });
    }
    const log = useChatStore.getState().bySession[S];
    expect(log).toHaveLength(cap);
    expect(log[0].text).toBe('5'); // 先頭5件破棄
  });
});

describe('applySnapshot', () => {
  it('snapshot で map/status/cond を全置換', () => {
    // 既存状態を汚しておく
    useMapStore.getState().setMap(S, {
      type: 'map', session: S, size: 99, dir: 0, style: 'solid',
      mapset: 'old', cells: [], chars: [],
    });

    const snap: SnapshotEvent = {
      type: 'snapshot', session: S,
      status: {
        name: 'X', hp: 7, maxHp: 7, mp: 0, maxMp: 0,
        exp: 0, gp: 0, f: 0, w: 0, m: 0, c: 0,
      },
      cond: {
        poison: false, palsy: true, panic: false, confuse: false,
        berserk: false, silence: false, blind: false,
      },
      map: {
        size: 5, dir: 0, style: 'solid', mapset: 'new',
        cells: [{ chip: 2, attr: 0 }], chars: [],
      },
      userList: { users: [{ key: 'u1', name: 'A' }] },
    };

    applySnapshot(S, snap);

    expect(useMapStore.getState().bySession[S]?.mapset).toBe('new');
    expect(useMapStore.getState().bySession[S]?.size).toBe(5);
    expect(useStatusStore.getState().bySession[S].status?.hp).toBe(7);
    expect(useStatusStore.getState().bySession[S].cond?.palsy).toBe(true);
  });

  it('chat は snapshot で全置換せず温存(追記方針)', () => {
    useChatStore.getState().addMessage(S, {
      type: 'message', session: S, channel: 'log', text: 'keep',
    });
    applySnapshot(S, { type: 'snapshot', session: S });
    expect(useChatStore.getState().bySession[S].map((m) => m.text)).toContain('keep');
  });
});
