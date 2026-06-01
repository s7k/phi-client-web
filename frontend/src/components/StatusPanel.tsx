/**
 * F6: ステータス / 状態異常表示。
 * statusStore(HP/MP/EXP/GP + 属性値) と cond(状態異常)を近代的UIで表示。
 */
import { useStatusStore } from '../stores/statusStore';
import type { CondState } from '../stores/statusStore';
import './StatusPanel.css';

/** 状態異常ラベル(表示順)。 */
const COND_LABELS: { key: keyof CondState; label: string }[] = [
  { key: 'poison', label: '毒' },
  { key: 'palsy', label: '麻痺' },
  { key: 'panic', label: '恐慌' },
  { key: 'confuse', label: '混乱' },
  { key: 'berserk', label: '狂戦' },
  { key: 'silence', label: '沈黙' },
  { key: 'blind', label: '盲目' },
];

function Bar({
  label,
  value,
  max,
  variant,
}: {
  label: string;
  value: number;
  max: number;
  variant: 'hp' | 'mp';
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className={`stat-bar stat-bar--${variant}`}>
      <div className="stat-bar__head">
        <span className="stat-bar__label">{label}</span>
        <span className="stat-bar__value">
          {value} / {max}
        </span>
      </div>
      <div className="stat-bar__track">
        <div
          className="stat-bar__fill"
          style={{ width: `${ratio * 100}%` }}
          role="progressbar"
          aria-valuenow={value}
          aria-valuemax={max}
        />
      </div>
    </div>
  );
}

export function StatusPanel({ session }: { session: string }) {
  const entry = useStatusStore((s) => s.bySession[session]);
  const status = entry?.status;
  const cond = entry?.cond;

  if (!status) {
    return <div className="status-panel status-panel--empty">ステータス未取得</div>;
  }

  return (
    <div className="status-panel">
      <div className="status-panel__name">{status.name}</div>

      <Bar label="HP" value={status.hp} max={status.maxHp} variant="hp" />
      <Bar label="MP" value={status.mp} max={status.maxMp} variant="mp" />

      <div className="status-panel__meta">
        <span>
          EXP <strong>{status.exp}</strong>
        </span>
        <span>
          GP <strong>{status.gp}</strong>
        </span>
      </div>

      <div className="status-panel__attrs">
        <span title="火">F {status.f}</span>
        <span title="水">W {status.w}</span>
        <span title="風">M {status.m}</span>
        <span title="地">C {status.c}</span>
      </div>

      <div className="status-panel__conds">
        {COND_LABELS.filter((c) => cond?.[c.key]).map((c) => (
          <span key={c.key} className="cond-chip" data-cond={c.key}>
            {c.label}
          </span>
        ))}
        {(!cond || COND_LABELS.every((c) => !cond[c.key])) && (
          <span className="cond-chip cond-chip--none">正常</span>
        )}
      </div>
    </div>
  );
}
