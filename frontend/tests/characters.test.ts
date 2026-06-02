import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listCharacters,
  createCharacter,
  deleteCharacter,
  CharacterError,
} from '../src/api/characters';
import { setStoredToken, clearStoredToken } from '../src/api/auth';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  clearStoredToken();
});

describe('listCharacters (GET /api/characters, Bearer)', () => {
  it('Bearer 付きで取得し characters を返す', async () => {
    setStoredToken('tk-1');
    const chars = [{ charId: 'c1', label: 'Hero', host: '10.0.0.1', port: 20000 }];
    const f = vi.fn().mockResolvedValue(jsonResponse({ characters: chars }));
    const res = await listCharacters(f as unknown as typeof fetch);
    expect(res).toEqual(chars);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/characters');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tk-1');
  });

  it('配列直返しも許容', async () => {
    const chars = [{ charId: 'c1', label: 'A', host: 'h', port: 1 }];
    const f = vi.fn().mockResolvedValue(jsonResponse(chars));
    const res = await listCharacters(f as unknown as typeof fetch);
    expect(res).toEqual(chars);
  });

  it('uid(PHI ID)は応答に含まれない(charId で参照)', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ characters: [{ charId: 'c1', label: 'A', host: 'h', port: 1 }] }));
    const res = await listCharacters(f as unknown as typeof fetch);
    expect('uid' in res[0]).toBe(false);
    expect('phiId' in res[0]).toBe(false);
  });

  it('HTTP エラーで CharacterError', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 401 }));
    await expect(
      listCharacters(f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(CharacterError);
  });
});

describe('createCharacter (POST /api/characters, Bearer)', () => {
  it('label/phiId/host/port を Bearer 付きで送る', async () => {
    setStoredToken('tk-1');
    const f = vi
      .fn()
      .mockResolvedValue(jsonResponse({ charId: 'c2', label: 'Mage', host: 'h', port: 21000 }));
    const res = await createCharacter(
      { label: 'Mage', phiId: 'PHI123', host: 'h', port: 21000 },
      f as unknown as typeof fetch,
    );
    expect(res).toMatchObject({ charId: 'c2', label: 'Mage' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/characters');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tk-1');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ label: 'Mage', phiId: 'PHI123', host: 'h', port: 21000 });
  });

  it('charId を含まない応答では null', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const res = await createCharacter(
      { label: 'A', phiId: 'X', host: 'h', port: 1 },
      f as unknown as typeof fetch,
    );
    expect(res).toBeNull();
  });

  it('HTTP エラーで CharacterError', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 400 }));
    await expect(
      createCharacter(
        { label: 'A', phiId: 'X', host: 'h', port: 1 },
        f as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(CharacterError);
  });
});

describe('deleteCharacter (DELETE /api/characters/{charId}, Bearer)', () => {
  it('charId を URL に含めて Bearer 付きで DELETE', async () => {
    setStoredToken('tk-1');
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await deleteCharacter('c1', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/characters/c1');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer tk-1');
  });

  it('charId を URL エンコード', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await deleteCharacter('a/b c', f as unknown as typeof fetch);
    expect(f.mock.calls[0][0]).toBe('/api/characters/a%2Fb%20c');
  });

  it('HTTP エラーで CharacterError', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 404 }));
    await expect(
      deleteCharacter('c1', f as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(CharacterError);
  });
});
