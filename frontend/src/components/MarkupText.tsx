/**
 * 色マークアップ付きテキストを装飾レンダリング(F7/F11)。
 * markup=true のメッセージのみ parseMarkup を通す。false は素のテキスト。
 *
 * - text セグメント: 色付き span。
 * - image セグメント(img= タグ): サニタイズ済 URL を <img>。
 *   referrerPolicy/loading 等で外部読み込みを抑制(CSP前提, [05]§13)。
 */
import { parseMarkup } from '../lib/colorMarkup';

export function MarkupText({
  text,
  markup,
}: {
  text: string;
  markup?: boolean;
}) {
  if (!markup) {
    return <>{text}</>;
  }
  const segments = parseMarkup(text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'image' ? (
          <img
            key={`${seg.kind}-${i}`}
            className="markup-img"
            src={seg.url}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span key={`${seg.kind}-${i}`} style={seg.color ? { color: seg.color } : undefined}>
            {seg.text}
          </span>
        ),
      )}
    </>
  );
}
