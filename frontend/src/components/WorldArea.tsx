/**
 * 世界名/エリア名表示(CR-3, [07]§6.12 notice)。
 * session別 noticeStore から world/area を表示。
 */
import { useNoticeStore } from '../stores/noticeStore';

export function WorldArea({ session }: { session: string }) {
  const notice = useNoticeStore((s) => s.bySession[session]);
  if (!notice || (!notice.world && !notice.area)) return null;

  return (
    <div className="world-area" data-testid="world-area">
      {notice.world && <span className="world-area__world">{notice.world}</span>}
      {notice.area && <span className="world-area__area">{notice.area}</span>}
    </div>
  );
}
