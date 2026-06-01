/**
 * 色マークアップ付きテキストを装飾レンダリング(F7)。
 * markup=true のメッセージのみ parseMarkup を通す。false は素のテキスト。
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
      {segments.map((seg, i) => (
        <span
          key={i}
          style={seg.color ? { color: seg.color } : undefined}
        >
          {seg.text}
        </span>
      ))}
    </>
  );
}
