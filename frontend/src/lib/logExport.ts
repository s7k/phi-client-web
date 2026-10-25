/**
 * チャットログをテキストで保存する(Philly のログバッファー保存)。
 * カラーマークアップは外し、画像は URL を残す。
 */
import { parseMarkup } from './colorMarkup';
import { triggerDownload } from './screenshot';
import type { ChatEntry } from '../stores/chatStore';

/** 1行分の本文。マークアップを外す。 */
function plain(e: ChatEntry): string {
  if (!e.markup) return e.text;
  return parseMarkup(e.text)
    .map((s) => (s.kind === 'text' ? s.text : `[画像 ${s.url}]`))
    .join('');
}

export function logToText(entries: ChatEntry[]): string {
  return entries.map((e) => plain(e)).join('\n') + '\n';
}

/** phi-log-<キャラ名>-YYYYMMDD-HHMMSS.txt */
export function logFilename(name: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  // ファイル名に使えない文字を避ける
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, '_') || 'log';
  return `phi-log-${safe}-${d}.txt`;
}

export function saveLog(entries: ChatEntry[], name: string): void {
  const blob = new Blob([logToText(entries)], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, logFilename(name));
}
