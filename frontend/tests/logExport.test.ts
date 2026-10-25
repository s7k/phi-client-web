import { describe, it, expect } from 'vitest';
import { logToText, logFilename } from '../src/lib/logExport';
import type { ChatEntry } from '../src/stores/chatStore';

const e = (text: string, markup = false): ChatEntry =>
  ({ _id: 0, session: 's1', channel: 'log', text, markup }) as ChatEntry;

describe('logExport', () => {
  it('マークアップを外し、1行ずつ並べる', () => {
    expect(logToText([e('DM > hello'), e('/*color=red*/赤字/*.*/です', true)])).toBe(
      'DM > hello\n赤字です\n',
    );
  });

  it('ファイル名に使えない文字を置き換える', () => {
    expect(logFilename('朱蓮 World/Master', new Date(2026, 9, 25, 12, 3, 4))).toBe(
      'phi-log-朱蓮_World_Master-20261025-120304.txt',
    );
  });
});
