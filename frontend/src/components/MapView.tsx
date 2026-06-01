/**
 * F4 マップ描画。Canvas にチップ/キャラ/アイテム/看板を描画(map_widget.py 移植)。
 *
 * - map状態は mapStore(session別)から取得。
 * - 画像ロードは useImages で抽象化(テスト時 loader 差替)。
 * - 描画ロジックは drawMap(純粋)へ委譲。
 * - アニメフレームは 250ms 間隔で 0/1 トグル(2フレーム歩行サイクル)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMapStore } from '../stores/mapStore';
import { CHIP_SIZE, gridDim, hasItem } from '../lib/mapRender';
import { graCandidateUrls } from '../lib/charaGra';
import { drawMap, type ImageRefs } from '../lib/drawMap';
import { useImages, type ImageLoader } from '../lib/useImage';

/** mapsetチップシート配信URL(小文字化)。 */
export function chipUrl(mapset: string): string {
  const name = mapset && mapset.trim() ? mapset.toLowerCase() : 'default';
  return `/assets/chip/${name}.png`;
}

/** items.png 配信URL。 */
export const ITEMS_URL = '/assets/items/items.png';

export interface MapViewProps {
  session: string;
  /** テスト用ローダ差替。 */
  loader?: ImageLoader;
  /** アニメ無効化(テスト用)。 */
  disableAnimation?: boolean;
}

export function MapView({ session, loader, disableAnimation }: MapViewProps) {
  const map = useMapStore((s) => s.bySession[session]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [animFrame, setAnimFrame] = useState(0);

  // アニメフレームトグル。
  useEffect(() => {
    if (disableAnimation) return;
    const t = setInterval(() => setAnimFrame((f) => f ^ 1), 250);
    return () => clearInterval(t);
  }, [disableAnimation]);

  // ロード対象URL(チップ + items + 全キャラ候補)。
  const urls = useMemo(() => {
    if (!map) return [] as string[];
    const set = new Set<string>();
    set.add(chipUrl(map.mapset));
    if (map.cells.some((c) => hasItem(c.attr))) set.add(ITEMS_URL);
    for (const ch of map.chars) {
      for (const u of graCandidateUrls(ch.gra, ch.default)) set.add(u);
    }
    return Array.from(set);
  }, [map]);

  const cache = useImages(urls, loader);

  // 描画。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      // jsdom等 getContext 未実装環境では描画スキップ。
      ctx = null;
    }
    if (!ctx) return;

    const imgs: ImageRefs = {
      chip: cache.get(chipUrl(map.mapset)) ?? null,
      items: cache.get(ITEMS_URL) ?? null,
      chara: (url) => cache.get(url) ?? null,
    };
    drawMap(ctx, map, imgs, animFrame);
  }, [map, cache, animFrame]);

  if (!map) {
    return <div className="map-view map-view--empty" data-testid="map-empty" />;
  }

  const dim = gridDim(map.size);
  const px = dim * CHIP_SIZE;
  return (
    <canvas
      ref={canvasRef}
      className="map-view"
      data-testid="map-canvas"
      width={px}
      height={px}
      style={{ width: px, height: px, imageRendering: 'pixelated', background: '#000' }}
    />
  );
}
