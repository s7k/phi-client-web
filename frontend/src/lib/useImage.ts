/**
 * 画像ロード抽象化。URL → HTMLImageElement(ロード完了後)。
 * テストでは loader を差し替えてモック可能。
 */
import { useEffect, useRef, useState } from 'react';

export type ImageLoader = (url: string) => Promise<HTMLImageElement>;

/** 既定ローダ: new Image() で非同期ロード。 */
export const defaultImageLoader: ImageLoader = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像ロード失敗: ${url}`));
    img.src = url;
  });

export interface ImageCache {
  /** 解決済画像(無ければ undefined)。 */
  get(url: string): HTMLImageElement | undefined;
}

/**
 * 複数URLをロードしキャッシュするフック。
 * ロード完了で再レンダ誘発。失敗URLは null としてキャッシュ(再試行抑止)。
 *
 * @param urls    ロード対象URL群。
 * @param loader  画像ローダ(テスト差し替え用)。
 */
export function useImages(
  urls: readonly string[],
  loader: ImageLoader = defaultImageLoader,
): ImageCache {
  const cacheRef = useRef<Map<string, HTMLImageElement | null>>(new Map());
  const [, force] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cache = cacheRef.current;
    const pending = urls.filter((u) => u && !cache.has(u));
    if (pending.length === 0) return;

    // ロード中マークは null と区別するため undefined のままにし、
    // Promise解決後に set する。重複起動は has チェックで概ね回避。
    Promise.all(
      pending.map((u) =>
        loader(u)
          .then((img) => {
            if (!cancelled) cache.set(u, img);
          })
          .catch(() => {
            if (!cancelled) cache.set(u, null);
          }),
      ),
    ).then(() => {
      if (!cancelled) force((n) => n + 1);
    });

    return () => {
      cancelled = true;
    };
    // urls は呼び出し側で安定化(useMemo)前提。join でキー化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls.join('|'), loader]);

  return {
    get: (url) => cacheRef.current.get(url) ?? undefined,
  };
}
