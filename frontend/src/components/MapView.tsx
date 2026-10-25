/**
 * F4 マップ描画。Canvas にチップ/キャラ/アイテム/看板を描画(map_widget.py 移植)。
 *
 * - map状態は mapStore(session別)から取得。
 * - 画像ロードは useImages で抽象化(テスト時 loader 差替)。
 * - 描画ロジックは drawMap(純粋)へ委譲。
 * - アニメフレームは 250ms 間隔で 0/1 トグル(2フレーム歩行サイクル)。
 * - 絶対座標が届く世界(朱蓮)では、外周に記録地図を暗くして敷く(automapStore)。
 *   モバイル幅はマップ領域が狭いので敷かない。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMapStore } from '../stores/mapStore';
import { useNoticeStore } from '../stores/noticeStore';
import { AUTOMAP_RING, composeAutomap, useAutomapStore } from '../stores/automapStore';
import { useSettingsStore, type DisplaySettings } from '../stores/settingsStore';
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
  const cellScale =
    useSettingsStore((s) => (s.byScope['display'] as DisplaySettings | undefined)?.cellScale) ?? 1;
  const cellSize = CHIP_SIZE * cellScale;
  const world = useNoticeStore((s) => s.bySession[session]?.world);
  const tiles = useAutomapStore((s) => (world ? s.byWorld[world] : undefined));
  // リサイズは次のマップ更新(約1秒毎)で反映する
  const narrow = window.matchMedia?.('(max-width: 820px)').matches ?? false;
  const automap = useMemo(
    () => (map && !narrow ? composeAutomap(map, tiles) : null),
    [map, tiles, narrow],
  );
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
    if (!automap) {
      drawMap(ctx, map, imgs, animFrame, cellSize);
      return;
    }
    drawMap(ctx, { ...map, ...automap }, imgs, animFrame, cellSize);
    // 外周(記録地図)を暗くし、中央の通常マップと見分ける
    const full = automap.dim * cellSize;
    const edge = AUTOMAP_RING * cellSize;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, full, edge);
    ctx.fillRect(0, full - edge, full, edge);
    ctx.fillRect(0, edge, edge, full - 2 * edge);
    ctx.fillRect(full - edge, edge, edge, full - 2 * edge);
  }, [map, automap, cache, animFrame, cellSize]);

  if (!map) {
    return <div className="map-view map-view--empty" data-testid="map-empty" />;
  }

  const dim = automap?.dim ?? gridDim(map.size);
  const px = dim * cellSize;
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
