import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listGraphics,
  uploadGraphic,
  deleteGraphic,
  listChips,
  uploadChip,
  deleteChip,
  listIndex,
  putIndex,
  deleteIndex,
  AssetError,
} from '../src/api/assets';
import { setStoredToken, clearStoredToken } from '../src/api/auth';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => clearStoredToken());

describe('chara graphics API', () => {
  it('listGraphics は GET し配列を返す', async () => {
    setStoredToken('tk');
    const items = [
      { graName: 'g', url: '/u', width: 96, height: 160, colorKey: 'teal', protected: false, uploadedAt: 't' },
    ];
    const f = vi.fn().mockResolvedValue(jsonResponse(items));
    const res = await listGraphics(f as unknown as typeof fetch);
    expect(res).toEqual(items);
    expect(f.mock.calls[0][0]).toBe('/api/chara/graphics');
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tk' });
  });

  it('uploadGraphic は multipart(file/graName/colorKey)を POST', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ graName: 'g' }));
    const file = new File([new Uint8Array([1, 2])], 'g.bmp', { type: 'image/bmp' });
    await uploadGraphic(file, 'g', 'teal', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chara/graphics');
    expect(init.method).toBe('POST');
    const fd = init.body as FormData;
    expect(fd.get('graName')).toBe('g');
    expect(fd.get('colorKey')).toBe('teal');
    expect(fd.get('file')).toBeInstanceOf(File);
  });

  it('FastAPI detail エラーを message に拾う', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ detail: '同名グラ既存' }, { ok: false, status: 409 }));
    await expect(uploadGraphic(new File([], 'x'), 'g', 'teal', f as unknown as typeof fetch))
      .rejects.toMatchObject({ message: '同名グラ既存', status: 409 });
  });

  it('deleteGraphic は URL エンコードして DELETE', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ deleted: 'a b' }));
    await deleteGraphic('a b', f as unknown as typeof fetch);
    expect(f.mock.calls[0][0]).toBe('/api/chara/graphics/a%20b');
    expect((f.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('HTTP エラーで AssetError', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 403 }));
    await expect(deleteGraphic('g', f as unknown as typeof fetch)).rejects.toBeInstanceOf(AssetError);
  });
});

describe('chip API', () => {
  it('listChips は GET /api/chip/graphics', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse([]));
    await listChips(f as unknown as typeof fetch);
    expect(f.mock.calls[0][0]).toBe('/api/chip/graphics');
  });

  it('uploadChip は multipart(file/mapset)を POST', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ mapset: 'town' }));
    await uploadChip(new File([], 't.bmp'), 'town', f as unknown as typeof fetch);
    const init = f.mock.calls[0][1] as RequestInit;
    const fd = init.body as FormData;
    expect(fd.get('mapset')).toBe('town');
  });

  it('deleteChip は DELETE', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ deleted: 'town' }));
    await deleteChip('town', f as unknown as typeof fetch);
    expect(f.mock.calls[0][0]).toBe('/api/chip/graphics/town');
  });
});

describe('index API', () => {
  it('putIndex は graName を PUT', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ key: 'k', graName: 'g' }));
    const res = await putIndex('k', 'g', f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chara/index/k');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ graName: 'g' });
    expect(res).toEqual({ key: 'k', graName: 'g' });
  });

  it('listIndex / deleteIndex', async () => {
    const f1 = vi.fn().mockResolvedValue(jsonResponse([{ key: 'k', graName: 'g' }]));
    expect(await listIndex(f1 as unknown as typeof fetch)).toHaveLength(1);
    const f2 = vi.fn().mockResolvedValue(jsonResponse({ deleted: 'k' }));
    await deleteIndex('k', f2 as unknown as typeof fetch);
    expect(f2.mock.calls[0][0]).toBe('/api/chara/index/k');
  });
});
