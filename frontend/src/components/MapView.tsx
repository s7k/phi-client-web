/**
 * F4 マップ描画。Canvas にチップ/キャラ/アイテム/看板を描画(map_widget.py 移植)。
 *
 * - map状態は mapStore(session別)から取得。
 * - 画像ロードは useImages で抽象化(テスト時 loader 差替)。
 * - 描画ロジックは drawMap(純粋)へ委譲。
 * - アニメフレームは 250ms 間隔で 0/1 トグル(2フレーム歩行サイクル)。
 * - 左クリックでクリックした方向へ1歩、右クリックで攻撃(Philly のマップ操作)。
 * - 絶対座標が届く世界(朱蓮)では、外周に記録地図を暗くして敷く(automapStore)。
 *   モバイル幅はマップ領域が狭いので敷かない。
 *   通常マップの視界外('?')も、記録があれば暗くして記録地図で埋める。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMapStore } from '../stores/mapStore';
import { useNoticeStore } from '../stores/noticeStore';
import { AUTOMAP_RING, composeAutomap, useAutomapStore } from '../stores/automapStore';
import { useSettingsStore, type DisplaySettings } from '../stores/settingsStore';
import { CHIP_SIZE, gridDim, hasItem } from '../lib/mapRender';
import { graCandidateUrls } from '../lib/charaGra';
import { drawMap, type ImageRefs } from '../lib/drawMap';
import { actionToIntent, type MoveAction } from '../lib/keyHandler';
import { useWs } from '../ws/WsContext';
import { useImages, type ImageLoader } from '../lib/useImage';

/** mapsetチップシート配信URL(小文字化)。 */
export function chipUrl(mapset: string): string {
  const name = mapset && mapset.trim() ? mapset.toLowerCase() : 'default';
  return `/assets/chip/${name}.png`;
}

/**
 * 盤面中心からのクリック位置(セル単位) → 移動アクション。縦横の大きい方を採る。
 * 自キャラのマス内(中心から半マス以内)は null。
 */
export function clickToMove(dx: number, dy: number): MoveAction | null {
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'forward' : 'back';
  return dx < 0 ? 'strafeL' : 'strafeR';
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
  const ws = useWs();
  const world = useNoticeStore((s) => s.bySession[session]?.world);
  const tiles = useAutomapStore((s) => (world ? s.byWorld[world] : undefined));
  // リサイズは次のマップ更新(約1秒毎)で反映する
  const narrow = window.matchMedia?.('(max-width: 820px)').matches ?? false;
  const automap = useMemo(
    () => (map ? composeAutomap(map, tiles, narrow ? 0 : AUTOMAP_RING) : null),
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
    // 記録地図から描いたマスを暗くし、今見えているマスと見分ける
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    automap.recalled.forEach((on, i) => {
      if (on) {
        ctx.fillRect((i % automap.dim) * cellSize, Math.floor(i / automap.dim) * cellSize, cellSize, cellSize);
      }
    });
  }, [map, automap, cache, animFrame, cellSize]);

  if (!map) {
    return <div className="map-view map-view--empty" data-testid="map-empty" />;
  }

  const dim = automap?.dim ?? gridDim(map.size);
  const px = dim * cellSize;

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    // CSS で縮小表示している事がある(モバイル)為、表示サイズからセル単位へ直す
    const r = e.currentTarget.getBoundingClientRect();
    const cell = r.width / dim;
    const action = clickToMove(
      (e.clientX - r.left - r.width / 2) / cell,
      (e.clientY - r.top - r.height / 2) / cell,
    );
    if (!action) return;
    const intent = actionToIntent(action, map!.style === 'solid');
    if (intent.type === 'move') ws.sendMove(session, { mode: intent.mode, dir: intent.dir });
  }

  function handleContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
    ws.sendCommand(session, { name: 'hit' });
  }
  return (
    <canvas
      ref={canvasRef}
      className="map-view"
      data-testid="map-canvas"
      title="クリックで移動 / 右クリックで攻撃"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      width={px}
      height={px}
      style={{ width: px, height: px, imageRendering: 'pixelated', background: '#000' }}
    />
  );
}
