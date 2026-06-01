import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Register } from '../src/components/Register';
import {
  fetchRegisterGraphics,
  postRegister,
  RegisterError,
} from '../src/api/register';

/** fetch を差し替え可能にするヘルパ。Response 風オブジェクトを返す。 */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// REST クライアント(api/register.ts)
// ============================================================

describe('fetchRegisterGraphics', () => {
  it('graphics 配列を index 付きで返す', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ graphics: ['elf', 'mage', 'knight'] }));
    const list = await fetchRegisterGraphics(f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith('/api/register/graphics', expect.objectContaining({ method: 'GET' }));
    expect(list).toEqual([
      { index: 0, gra: 'elf' },
      { index: 1, gra: 'mage' },
      { index: 2, gra: 'knight' },
    ]);
  });

  it('配列直返しも許容', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse(['a', 'b']));
    const list = await fetchRegisterGraphics(f as unknown as typeof fetch);
    expect(list.map((g) => g.gra)).toEqual(['a', 'b']);
  });

  it('HTTP エラーで throw', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));
    await expect(fetchRegisterGraphics(f as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe('postRegister', () => {
  it('成功で {charId, name}', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ charId: 'c9', name: 'Hero' }));
    const res = await postRegister(
      { name: 'Hero', pass: 'abc123', imageIndex: 1 },
      f as unknown as typeof fetch,
    );
    expect(res).toEqual({ charId: 'c9', name: 'Hero' });
    const [, init] = f.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ name: 'Hero', pass: 'abc123', imageIndex: 1 });
  });

  it('REGISTER_REJECT で RegisterError(fields)', async () => {
    const f = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: 'REGISTER_REJECT', fields: ['name', 'pass'] } },
        { ok: false, status: 400 },
      ),
    );
    await expect(
      postRegister({ name: 'X', pass: 'abc123', imageIndex: 0 }, f as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'REGISTER_REJECT', fields: ['name', 'pass'] });
  });
});

// ============================================================
// Register コンポーネント(F12)
// ============================================================

describe('Register コンポーネント', () => {
  it('グラ一覧を取得し選択肢を描画', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ graphics: ['elf', 'mage'] }));
    vi.stubGlobal('fetch', f);
    render(<Register onRegistered={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('gra-elf')).toBeTruthy());
    expect(screen.getByLabelText('gra-mage')).toBeTruthy();
  });

  it('パスワード6文字未満はクライアントバリデーションでエラー(送信せず)', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ graphics: ['elf'] }));
    vi.stubGlobal('fetch', f);
    render(<Register onRegistered={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('gra-elf')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('キャラ名'), { target: { value: 'Hero' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('登録'));

    await waitFor(() => expect(screen.getByText('パスワードは正確に6文字')).toBeTruthy());
    // POST は呼ばれない(GET のみ)
    expect(f.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);
  });

  it('キャラ名2文字未満でバリデーションエラー', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ graphics: ['elf'] }));
    vi.stubGlobal('fetch', f);
    render(<Register onRegistered={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('gra-elf')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('キャラ名'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByText('登録'));
    await waitFor(() => expect(screen.getByText('キャラ名は2文字以上')).toBeTruthy());
  });

  it('成功で onRegistered(name) 呼出', async () => {
    const f = vi.fn().mockImplementation((_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ charId: 'c1', name: 'Hero' }));
      }
      return Promise.resolve(jsonResponse({ graphics: ['elf', 'mage'] }));
    });
    vi.stubGlobal('fetch', f);
    const onRegistered = vi.fn();
    render(<Register onRegistered={onRegistered} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('gra-elf')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('キャラ名'), { target: { value: 'Hero' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByLabelText('gra-mage'));
    fireEvent.click(screen.getByText('登録'));

    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith('Hero'));
    const postCall = f.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(JSON.parse(postCall[1].body)).toMatchObject({ name: 'Hero', pass: 'abc123', imageIndex: 1 });
  });

  it('reject 応答でフィールド別エラー表示', async () => {
    const f = vi.fn().mockImplementation((_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'REGISTER_REJECT', fields: ['name', 'image'] } },
            { ok: false, status: 400 },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ graphics: ['elf'] }));
    });
    vi.stubGlobal('fetch', f);
    render(<Register onRegistered={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('gra-elf')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('キャラ名'), { target: { value: 'Hero' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByText('登録'));

    await waitFor(() => expect(screen.getByText('キャラ名が拒否されました')).toBeTruthy());
    expect(screen.getByText('初期グラフィックが拒否されました')).toBeTruthy();
  });

  it('戻るボタンで onCancel', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ graphics: [] }));
    vi.stubGlobal('fetch', f);
    const onCancel = vi.fn();
    render(<Register onRegistered={() => {}} onCancel={onCancel} />);
    // グラ取得(空)完了を待ってから操作(act警告回避)。
    await waitFor(() => expect(screen.queryByText('読み込み中…')).toBeNull());
    fireEvent.click(screen.getByText('戻る'));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('RegisterError', () => {
  it('fields を保持', () => {
    const e = new RegisterError({ code: 'REGISTER_REJECT', fields: ['pass'] });
    expect(e.code).toBe('REGISTER_REJECT');
    expect(e.fields).toEqual(['pass']);
  });
});
