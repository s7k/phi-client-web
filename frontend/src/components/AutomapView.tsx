/**
 * 歩いて見た地形の地図(マッピング)。automapStore の自キャラ周辺を表示する。
 * 絶対座標(map.pos)を送る世界(朱蓮)でだけ出る。描画は EagleEye と同じ drawEagleEye。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useMapStore } from '../stores/mapStore';
import { useNoticeStore } from '../stores/noticeStore';
import { useAutomapStore, type AutomapTiles } from '../stores/automapStore';
import { drawEagleEye, EE_CELL } from '../lib/drawEagleEye';
import { useImages, type ImageLoader } from '../lib/useImage';
import type { MapCell } from '../types/protocol';
import { chipUrl } from './MapView';

/** 表示する範囲(自キャラ中心の正方形、奇数)。 */
export const AUTOMAP_SPAN = 21;

/** 自キャラ (x,y) を中心に AUTOMAP_SPAN 四方を切り出す。未踏のセルは空。 */
export function automapWindow(tiles: AutomapTiles, x: number, y: number): MapCell[] {
  const half = (AUTOMAP_SPAN - 1) / 2;
  const cells: MapCell[] = [];
  for (let r = 0; r < AUTOMAP_SPAN; r++) {
    for (let c = 0; c < AUTOMAP_SPAN; c++) {
      cells[r * AUTOMAP_SPAN + c] = tiles[`${x + c - half},${y + r - half}`];
    }
  }
  return cells;
}

export function AutomapView({ session, loader }: { session: string; loader?: ImageLoader }) {
  const pos = useMapStore((s) => s.bySession[session]?.pos);
  const mapset = useMapStore((s) => s.bySession[session]?.mapset ?? 'default');
  const world = useNoticeStore((s) => s.bySession[session]?.world);
  const tiles = useAutomapStore((s) => (world ? s.byWorld[world] : undefined));
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const urls = useMemo(() => (pos ? [chipUrl(mapset)] : []), [pos, mapset]);
  const cache = useImages(urls, loader);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pos || !tiles) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const half = (AUTOMAP_SPAN - 1) / 2;
    drawEagleEye(
      ctx,
      {
        width: AUTOMAP_SPAN,
        height: AUTOMAP_SPAN,
        self: { x: half, y: half },
        cells: automapWindow(tiles, pos.x, pos.y),
      },
      { chip: cache.get(chipUrl(mapset)) ?? null },
    );
  }, [pos, tiles, cache, mapset]);

  if (!pos || !tiles) return null;
  const px = AUTOMAP_SPAN * EE_CELL;
  return (
    <canvas
      ref={canvasRef}
      className="automap"
      data-testid="automap-canvas"
      title={`現在地 (${pos.x}, ${pos.y})`}
      width={px}
      height={px}
      style={{ width: px, height: px, imageRendering: 'pixelated', background: '#000' }}
    />
  );
}
