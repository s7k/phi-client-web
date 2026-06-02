import { describe, it, expect, vi } from 'vitest';
import { shouldNotify, notify, stripMarkup } from '../src/lib/notify';
import { DEFAULT_NOTIFY, type NotifySettings } from '../src/stores/settingsStore';

function settings(over: Partial<NotifySettings> = {}): NotifySettings {
  return { ...DEFAULT_NOTIFY, ...over };
}

describe('stripMarkup', () => {
  it('色タグと img= を除去', () => {
    expect(stripMarkup('/*r*/赤/*.*/ /*img=https://e/a.png*/')).toBe('赤');
  });
});

describe('shouldNotify', () => {
  it('enabled=false は常に false', () => {
    expect(shouldNotify({ channel: 'priv', text: 'x' }, settings({ enabled: false }))).toBe(false);
  });

  it('system は通知しない', () => {
    expect(shouldNotify({ channel: 'system', text: 'x' }, settings())).toBe(false);
  });

  it('privOnly=true は priv のみ', () => {
    const s = settings({ privOnly: true });
    expect(shouldNotify({ channel: 'priv', text: 'x' }, s)).toBe(true);
    expect(shouldNotify({ channel: 'log', text: 'x' }, s)).toBe(false);
  });

  it('loud=false は loud を抑止', () => {
    expect(shouldNotify({ channel: 'loud', text: 'x' }, settings({ loud: false }))).toBe(false);
    expect(shouldNotify({ channel: 'loud', text: 'x' }, settings({ loud: true }))).toBe(true);
  });

  it('regexInclude 不一致で抑止', () => {
    const s = settings({ regexInclude: 'hello' });
    expect(shouldNotify({ channel: 'log', text: 'hello world' }, s)).toBe(true);
    expect(shouldNotify({ channel: 'log', text: 'bye' }, s)).toBe(false);
  });

  it('regexExclude 一致で抑止(markup除去後に照合)', () => {
    const s = settings({ regexExclude: '^DM >' });
    expect(shouldNotify({ channel: 'log', text: 'DM > spam' }, s)).toBe(false);
    expect(shouldNotify({ channel: 'log', text: '/*r*/DM > spam' }, s)).toBe(false);
    expect(shouldNotify({ channel: 'log', text: 'normal' }, s)).toBe(true);
  });

  it('不正な正規表現は照合無効化(通知を妨げない)', () => {
    const s = settings({ regexInclude: '[invalid(' });
    expect(shouldNotify({ channel: 'log', text: 'x' }, s)).toBe(true);
  });
});

describe('notify 発火', () => {
  it('判定通過で各手段(notification/flash/sound)を発火', () => {
    const deps = {
      showNotification: vi.fn(),
      flashTitle: vi.fn(),
      playSound: vi.fn(),
    };
    const ok = notify(
      { channel: 'priv', text: '/*r*/やあ/*.*/', from: 'Alice' },
      settings({ sound: true }),  // 既定sound=offのため明示有効化して発火を検証
      deps,
    );
    expect(ok).toBe(true);
    expect(deps.showNotification).toHaveBeenCalledWith('[priv] Alice', 'やあ');
    expect(deps.flashTitle).toHaveBeenCalledTimes(1);
    expect(deps.playSound).toHaveBeenCalledTimes(1);
  });

  it('sound/titleFlash 無効時はその手段を呼ばない', () => {
    const deps = {
      showNotification: vi.fn(),
      flashTitle: vi.fn(),
      playSound: vi.fn(),
    };
    notify({ channel: 'log', text: 'hi' }, settings({ sound: false, titleFlash: false }), deps);
    expect(deps.showNotification).toHaveBeenCalledTimes(1);
    expect(deps.flashTitle).not.toHaveBeenCalled();
    expect(deps.playSound).not.toHaveBeenCalled();
  });

  it('判定不成立なら何も発火せず false', () => {
    const deps = { showNotification: vi.fn(), flashTitle: vi.fn(), playSound: vi.fn() };
    const ok = notify({ channel: 'system', text: 'x' }, settings(), deps);
    expect(ok).toBe(false);
    expect(deps.showNotification).not.toHaveBeenCalled();
  });
});
