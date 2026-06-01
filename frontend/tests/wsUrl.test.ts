import { describe, it, expect } from 'vitest';
import { resolveWsUrl } from '../src/ws/wsUrl';

const http = { protocol: 'http:', host: 'localhost:5173' };
const https = { protocol: 'https:', host: 'example.com' };

describe('resolveWsUrl', () => {
  it('未指定なら相対 /ws を現オリジンで絶対化(ws)', () => {
    expect(resolveWsUrl(undefined, http)).toBe('ws://localhost:5173/ws');
  });

  it('空文字も既定 /ws 扱い', () => {
    expect(resolveWsUrl('', http)).toBe('ws://localhost:5173/ws');
    expect(resolveWsUrl('   ', http)).toBe('ws://localhost:5173/ws');
  });

  it('https オリジンは wss', () => {
    expect(resolveWsUrl('/ws', https)).toBe('wss://example.com/ws');
  });

  it('絶対 ws/wss URL はそのまま', () => {
    expect(resolveWsUrl('ws://be:8000/ws', http)).toBe('ws://be:8000/ws');
    expect(resolveWsUrl('wss://be:8000/socket', https)).toBe(
      'wss://be:8000/socket',
    );
  });

  it('相対パス(先頭/なし)も / 補完', () => {
    expect(resolveWsUrl('ws', http)).toBe('ws://localhost:5173/ws');
  });

  it('scheme相対 //host/path は現protocolで補完', () => {
    expect(resolveWsUrl('//be:8000/ws', http)).toBe('ws://be:8000/ws');
    expect(resolveWsUrl('//be:8000/ws', https)).toBe('wss://be:8000/ws');
  });

  it('任意の相対パスを尊重', () => {
    expect(resolveWsUrl('/api/ws', http)).toBe('ws://localhost:5173/api/ws');
  });
});
