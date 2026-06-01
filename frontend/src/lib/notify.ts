/**
 * F11 通知([05]§10, [12]§3.2)。
 *
 * `message` 受信時、notify 設定に応じて
 *   - ブラウザ Notification
 *   - タブタイトル点滅
 *   - 通知音
 * を発火。
 *
 * 設計: 判定(shouldNotify)は純関数でテスト可能。副作用(notify)は判定結果に基づき発火。
 * markup タグ(/*color=*​/ 等, img=)は通知本文・正規表現照合の前に除去。
 */
import type { MessageEvent } from '../types/protocol';
import type { NotifySettings } from '../stores/settingsStore';

/** 通知本文用にマークアップを除去したプレーンテキスト。 */
export function stripMarkup(text: string): string {
  return text
    .replace(/\/\*.*?\*\//g, '') // /*color=red*​/ 等
    .replace(/img=\S+/gi, '') // img=URL
    .trim();
}

/** 安全に RegExp を構築(不正パターンは null=照合無効化)。 */
function safeRegex(pattern: string | null | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * 通知すべきか判定([12]§3.2)。
 *
 * - enabled=false → 常に false。
 * - channel=system は通知しない(自分の操作結果等)。
 * - privOnly=true → priv 以外は false。
 * - loud=false → loud は false。
 * - regexInclude 指定時、本文が一致しなければ false。
 * - regexExclude 指定時、本文が一致すれば false。
 */
export function shouldNotify(
  msg: Pick<MessageEvent, 'channel' | 'text'>,
  settings: NotifySettings,
): boolean {
  if (!settings.enabled) return false;
  if (msg.channel === 'system') return false;
  if (settings.privOnly && msg.channel !== 'priv') return false;
  if (msg.channel === 'loud' && !settings.loud) return false;

  const body = stripMarkup(msg.text);
  const inc = safeRegex(settings.regexInclude);
  if (inc && !inc.test(body)) return false;
  const exc = safeRegex(settings.regexExclude);
  if (exc && exc.test(body)) return false;

  return true;
}

/** 副作用の差し替え可能な依存(テスト用)。 */
export interface NotifyDeps {
  /** ブラウザ Notification を出す。 */
  showNotification?: (title: string, body: string) => void;
  /** タブタイトルを点滅させる。 */
  flashTitle?: (text: string) => void;
  /** 通知音を鳴らす。 */
  playSound?: () => void;
}

/** 通知タイトル整形(発言者があれば付与)。 */
function notifyTitle(msg: Pick<MessageEvent, 'from' | 'channel'>): string {
  const prefix = msg.channel === 'priv' ? '[priv] ' : msg.channel === 'loud' ? '[大声] ' : '';
  return prefix + (msg.from ?? 'メッセージ');
}

/**
 * 判定に通れば通知を発火。設定の各フラグ(sound/titleFlash)に従い手段を選択。
 * Notification 自体は enabled 時に常に試行(権限は呼出側で取得済み前提)。
 */
export function notify(
  msg: Pick<MessageEvent, 'channel' | 'text' | 'from'>,
  settings: NotifySettings,
  deps: NotifyDeps = {},
): boolean {
  if (!shouldNotify(msg, settings)) return false;

  const body = stripMarkup(msg.text);
  const title = notifyTitle(msg);

  const show = deps.showNotification ?? defaultShowNotification;
  show(title, body);

  if (settings.titleFlash) {
    (deps.flashTitle ?? defaultFlashTitle)(title);
  }
  if (settings.sound) {
    (deps.playSound ?? defaultPlaySound)();
  }
  return true;
}

// ---------- 既定の副作用実装(ブラウザ) ----------

/** Notification 権限を要求(初回ユーザー操作後に呼ぶ)。 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  return Notification.requestPermission();
}

function defaultShowNotification(title: string, body: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body });
  } catch {
    // 一部環境(iOS Safari等)は constructor 不可。無視。
  }
}

// タイトル点滅の状態(モジュールローカル)。
let flashTimer: ReturnType<typeof setInterval> | null = null;
let originalTitle = '';

function defaultFlashTitle(text: string): void {
  if (typeof document === 'undefined') return;
  if (flashTimer === null) {
    originalTitle = document.title;
  } else {
    clearInterval(flashTimer);
  }
  let on = false;
  flashTimer = setInterval(() => {
    document.title = on ? originalTitle : `★ ${text}`;
    on = !on;
  }, 700);

  // フォーカス復帰で点滅停止。
  const stop = () => stopFlash();
  window.addEventListener('focus', stop, { once: true });
}

/** タイトル点滅を停止し元に戻す。 */
export function stopFlash(): void {
  if (flashTimer !== null) {
    clearInterval(flashTimer);
    flashTimer = null;
    if (typeof document !== 'undefined' && originalTitle) {
      document.title = originalTitle;
    }
  }
}

// 通知音(WebAudio で短いビープ)。AudioContext を遅延生成。
let audioCtx: AudioContext | null = null;

function defaultPlaySound(): void {
  const Ctx =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  try {
    if (!audioCtx) audioCtx = new Ctx();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {
    // 自動再生制限等。無視。
  }
}
