/**
 * F11 EagleEye(俯瞰)表示([07]§6.11)。
 * eagleEye イベント(典型 15×15 cells)を Canvas へ縮小描画。チップは map 流用。
 *
 * - eagleEye 状態は eagleEyeStore(session別)から取得。
 * - mapset(チップシート選択)は mapStore の現在マップから流用(EagleEye には mapset 無し)。
 * - 描画は drawEagleEye(純粋)へ委譲。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useEagleEyeStore } from '../stores/eagleEyeStore';
import { useMapStore } from '../stores/mapStore';
import { drawEagleEye, EE_CELL } from '../lib/drawEagleEye';
import { useImages, type ImageLoader } from '../lib/useImage';
import { chipUrl } from './MapView';

export interface EagleEyeViewProps {
  session: string;
  /** テスト用ローダ差替。 */
  loader?: ImageLoader;
}

export function EagleEyeView({ session, loader }: EagleEyeViewProps) {
  const ee = useEagleEyeStore((s) => s.bySession[session]);
  const mapset = useMapStore((s) => s.bySession[session]?.mapset ?? 'default');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const urls = useMemo(() => (ee ? [chipUrl(mapset)] : []), [ee, mapset]);
  const cache = useImages(urls, loader);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ee) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    drawEagleEye(ctx, ee, { chip: cache.get(chipUrl(mapset)) ?? null });
  }, [ee, cache, mapset]);

  if (!ee) {
    return (
      <div
        className="eagle-eye eagle-eye--empty"
        data-testid="eagle-eye-empty"
      />
    );
  }

  const w = ee.width * EE_CELL;
  const h = ee.height * EE_CELL;
  return (
    <canvas
      ref={canvasRef}
      className="eagle-eye"
      data-testid="eagle-eye-canvas"
      width={w}
      height={h}
      style={{ width: w, height: h, imageRendering: 'pixelated', background: '#000' }}
    />
  );
}
