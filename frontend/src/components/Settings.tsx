/**
 * F10 設定UI([12]§3, [05]§6,10)。
 *
 * scope 別に編集:
 *   - keybind: layout(wasd/numpad)・magic(F1-F7→呪文名)・shortcuts(F8-F12→語)・altG。
 *   - display: mapSize/mapStyle/eagleEye/fontScale/theme。
 *   - notify : enabled/privOnly/loud/regexInclude/regexExclude/sound/titleFlash。
 *   - intervals: mapUpdate/statusUpdate。
 *
 * 取得: mount時に settings.get([07]§5.7)。保存: 変更で settings.set(楽観更新)。
 * settingsStore と連携(取得結果は store へ反映され、再 open でも保持)。
 */
import { useEffect } from 'react';
import { useWs } from '../ws/WsContext';
import { useUiStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import {
  DEFAULT_DISPLAY,
  DEFAULT_INTERVALS,
  DEFAULT_KEYBIND,
  DEFAULT_NOTIFY,
  type DisplaySettings,
  type IntervalsSettings,
  type KeybindSettings,
  type NotifySettings,
} from '../stores/settingsStore';
import { requestNotificationPermission } from '../lib/notify';
import './Settings.css';

const MAGIC_KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'];
const SHORTCUT_KEYS = ['F8', 'F9', 'F10', 'F11', 'F12'];

export function Settings() {
  const ws = useWs();
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);

  const keybind = useSettingsStore((s) => s.byScope['keybind'] as KeybindSettings | undefined);
  const display = useSettingsStore((s) => s.byScope['display'] as DisplaySettings | undefined);
  const notify = useSettingsStore((s) => s.byScope['notify'] as NotifySettings | undefined);
  const intervals = useSettingsStore((s) => s.byScope['intervals'] as IntervalsSettings | undefined);

  // open 時に各 scope を取得([07]§5.7)。失敗(未配線等)は既定でフォールバック。
  useEffect(() => {
    if (!open) return;
    void ws.getSettings('keybind').catch(() => undefined);
    void ws.getSettings('display').catch(() => undefined);
    void ws.getSettings('notify').catch(() => undefined);
    void ws.getSettings('intervals').catch(() => undefined);
  }, [open, ws]);

  if (!open) return null;

  const kb: KeybindSettings = { ...DEFAULT_KEYBIND, ...keybind };
  const dp: DisplaySettings = { ...DEFAULT_DISPLAY, ...display };
  const nt: NotifySettings = { ...DEFAULT_NOTIFY, ...notify };
  const iv: IntervalsSettings = { ...DEFAULT_INTERVALS, ...intervals };

  const saveKeybind = (patch: Partial<KeybindSettings>) =>
    ws.setSettings('keybind', { ...kb, ...patch });
  const saveDisplay = (patch: Partial<DisplaySettings>) =>
    ws.setSettings('display', { ...dp, ...patch });
  const saveNotify = (patch: Partial<NotifySettings>) =>
    ws.setSettings('notify', { ...nt, ...patch });
  const saveIntervals = (patch: Partial<IntervalsSettings>) =>
    ws.setSettings('intervals', { ...iv, ...patch });

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="設定"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="settings">
        <header className="settings__header">
          <h2 className="settings__title">設定</h2>
          <button className="settings__close" aria-label="閉じる" onClick={() => setOpen(false)}>
            ×
          </button>
        </header>

        <div className="settings__body">
          {/* ---- keybind ---- */}
          <section className="settings__section" aria-label="キーバインド">
            <h3>キーバインド</h3>
            <label className="settings__row">
              <span>移動レイアウト</span>
              <select
                aria-label="移動レイアウト"
                value={kb.layout}
                onChange={(e) => saveKeybind({ layout: e.target.value as KeybindSettings['layout'] })}
              >
                <option value="wasd">WASD</option>
                <option value="numpad">テンキー</option>
              </select>
            </label>

            <fieldset className="settings__group">
              <legend>魔法(F1-F7 → 呪文名)</legend>
              {MAGIC_KEYS.map((k) => (
                <label key={k} className="settings__row">
                  <span>{k}</span>
                  <input
                    type="text"
                    aria-label={`magic-${k}`}
                    placeholder="呪文名"
                    value={kb.magic[k] ?? ''}
                    onChange={(e) =>
                      saveKeybind({ magic: { ...kb.magic, [k]: e.target.value || null } })
                    }
                  />
                </label>
              ))}
            </fieldset>

            <fieldset className="settings__group">
              <legend>ショートカット(F8-F12 → コマンド語)</legend>
              {SHORTCUT_KEYS.map((k) => (
                <label key={k} className="settings__row">
                  <span>{k}</span>
                  <input
                    type="text"
                    aria-label={`shortcut-${k}`}
                    placeholder="コマンド語"
                    value={kb.shortcuts[k] ?? ''}
                    onChange={(e) =>
                      saveKeybind({ shortcuts: { ...kb.shortcuts, [k]: e.target.value || null } })
                    }
                  />
                </label>
              ))}
            </fieldset>

            <label className="settings__row">
              <span>Shift+G ショートカット語</span>
              <input
                type="text"
                aria-label="altG"
                value={kb.altG}
                onChange={(e) => saveKeybind({ altG: e.target.value })}
              />
            </label>
          </section>

          {/* ---- display ---- */}
          <section className="settings__section" aria-label="表示">
            <h3>表示</h3>
            <label className="settings__row">
              <span>マップサイズ</span>
              <select
                aria-label="マップサイズ"
                value={dp.mapSize}
                onChange={(e) =>
                  saveDisplay({ mapSize: Number(e.target.value) as DisplaySettings['mapSize'] })
                }
              >
                <option value={40}>40</option>
                <option value={57}>57</option>
              </select>
            </label>
            <label className="settings__row">
              <span>マップ方式</span>
              <select
                aria-label="マップ方式"
                value={dp.mapStyle}
                onChange={(e) =>
                  saveDisplay({ mapStyle: e.target.value as DisplaySettings['mapStyle'] })
                }
              >
                <option value="solid">北固定(solid)</option>
                <option value="turn">回転(turn)</option>
              </select>
            </label>
            <label className="settings__row settings__row--check">
              <input
                type="checkbox"
                aria-label="EagleEye"
                checked={dp.eagleEye}
                onChange={(e) => saveDisplay({ eagleEye: e.target.checked })}
              />
              <span>EagleEye(俯瞰)</span>
            </label>
            <label className="settings__row">
              <span>文字倍率</span>
              <input
                type="range"
                aria-label="文字倍率"
                min={0.5}
                max={2}
                step={0.1}
                value={dp.fontScale}
                onChange={(e) => saveDisplay({ fontScale: Number(e.target.value) })}
              />
              <output>{dp.fontScale.toFixed(1)}</output>
            </label>
            <label className="settings__row">
              <span>テーマ</span>
              <select
                aria-label="テーマ"
                value={dp.theme}
                onChange={(e) => saveDisplay({ theme: e.target.value as DisplaySettings['theme'] })}
              >
                <option value="dark">ダーク</option>
                <option value="light">ライト</option>
              </select>
            </label>
          </section>

          {/* ---- notify ---- */}
          <section className="settings__section" aria-label="通知">
            <h3>通知</h3>
            <label className="settings__row settings__row--check">
              <input
                type="checkbox"
                aria-label="通知有効"
                checked={nt.enabled}
                onChange={(e) => {
                  if (e.target.checked) void requestNotificationPermission();
                  saveNotify({ enabled: e.target.checked });
                }}
              />
              <span>通知を有効化</span>
            </label>
            <label className="settings__row settings__row--check">
              <input
                type="checkbox"
                aria-label="priv限定"
                checked={nt.privOnly}
                onChange={(e) => saveNotify({ privOnly: e.target.checked })}
              />
              <span>privのみ通知</span>
            </label>
            <label className="settings__row settings__row--check">
              <input
                type="checkbox"
                aria-label="大声通知"
                checked={nt.loud}
                onChange={(e) => saveNotify({ loud: e.target.checked })}
              />
              <span>大声を含める</span>
            </label>
            <label className="settings__row settings__row--check">
              <input
                type="checkbox"
                aria-label="通知音"
                checked={nt.sound}
                onChange={(e) => saveNotify({ sound: e.target.checked })}
              />
              <span>通知音</span>
            </label>
            <label className="settings__row settings__row--check">
              <input
                type="checkbox"
                aria-label="タイトル点滅"
                checked={nt.titleFlash}
                onChange={(e) => saveNotify({ titleFlash: e.target.checked })}
              />
              <span>タブタイトル点滅</span>
            </label>
            <label className="settings__row">
              <span>含める(正規表現)</span>
              <input
                type="text"
                aria-label="regexInclude"
                value={nt.regexInclude ?? ''}
                onChange={(e) => saveNotify({ regexInclude: e.target.value || null })}
              />
            </label>
            <label className="settings__row">
              <span>除外(正規表現)</span>
              <input
                type="text"
                aria-label="regexExclude"
                value={nt.regexExclude ?? ''}
                onChange={(e) => saveNotify({ regexExclude: e.target.value || null })}
              />
            </label>
          </section>

          {/* ---- intervals ---- */}
          <section className="settings__section" aria-label="更新間隔">
            <h3>更新間隔(秒)</h3>
            <label className="settings__row">
              <span>マップ(#map-iv)</span>
              <input
                type="number"
                aria-label="mapUpdate"
                min={0}
                value={iv.mapUpdate}
                onChange={(e) => saveIntervals({ mapUpdate: Number(e.target.value) })}
              />
            </label>
            <label className="settings__row">
              <span>ステータス(#status-iv)</span>
              <input
                type="number"
                aria-label="statusUpdate"
                min={0}
                value={iv.statusUpdate}
                onChange={(e) => saveIntervals({ statusUpdate: Number(e.target.value) })}
              />
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}
