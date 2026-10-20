import { useEffect, useRef, useState, type ReactNode } from 'react';
import { evaluateNumericExpression } from '../core/numeric-expression';
import type { ObjectAlignment } from '../core/inspector-layout';

export type DesignIconName =
  | ObjectAlignment | 'distribute-x' | 'distribute-y' | 'rotate' | 'flip-x' | 'flip-y'
  | 'freeform' | 'vertical' | 'horizontal' | 'grid' | 'ratio' | 'ratio-unlocked'
  | 'opacity' | 'corner' | 'corners' | 'eye' | 'eye-off' | 'fill' | 'plus' | 'minus'
  | 'frame' | 'vector' | 'edit' | 'more' | 'reset' | 'chevron-right';

const ICON_PATHS: Record<DesignIconName, string> = {
  left: 'M3 2v12M6 5h7M6 8h4M6 11h7',
  'center-x': 'M8 2v12M3 5h10M5 8h6M3 11h10',
  right: 'M13 2v12M3 5h7M6 8h4M3 11h7',
  top: 'M2 3h12M5 6v7M8 6v4M11 6v7',
  'center-y': 'M2 8h12M5 3v10M8 5v6M11 3v10',
  bottom: 'M2 13h12M5 3v7M8 6v4M11 3v7',
  'distribute-x': 'M2 2v12M14 2v12M6 5h4v6H6z',
  'distribute-y': 'M2 2h12M2 14h12M5 6h6v4H5z',
  rotate: 'M5 3H2v3M2.5 4.5A5.2 5.2 0 1 1 3 11M8 5l3 3-3 3-3-3z',
  'flip-x': 'M8 2v12M5.5 4l-4 4 4 4zM10.5 4l4 4-4 4z',
  'flip-y': 'M2 8h12M4 5.5l4-4 4 4zM4 10.5l4 4 4-4z',
  freeform: 'M3 3h3v3H3zM10 3h3v3h-3zM6.5 10h3v3h-3z',
  vertical: 'M3 2h4v4H3zM3 9h4v4H3zM11 3v10M9 11l2 2 2-2',
  horizontal: 'M2 3h4v4H2zM9 3h4v4H9zM3 11h10M11 9l2 2-2 2',
  grid: 'M3 3h4v4H3zM10 3h4v4h-4zM3 10h4v4H3zM10 10h4v4h-4z',
  ratio: 'M6 10l4-4M5.5 7.5l-1 1a2.5 2.5 0 0 0 3.5 3.5l1-1M7 5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1',
  'ratio-unlocked': 'M3 3h10v10H3zM5.5 10.5l5-5M7 5.5h3.5V9',
  opacity: 'M3 3h10v10H3zM5 5h1M8 5h1M11 5h.1M5 8h1M8 8h1M11 8h.1M5 11h1M8 11h1M11 11h.1',
  corner: 'M3 10V6a3 3 0 0 1 3-3h4M3 13v-1M12 3h1M13 6v7H6',
  corners: 'M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM9.8 8a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0z',
  'eye-off': 'M2 2l12 12M6 4a7 7 0 0 1 2-.5c4 0 6.5 4.5 6.5 4.5a12 12 0 0 1-2 2.5M4 5.5C2.5 6.8 1.5 8 1.5 8S4 12.5 8 12.5c.9 0 1.7-.2 2.4-.5',
  fill: 'M8 1.5S3.5 7 3.5 10a4.5 4.5 0 0 0 9 0C12.5 7 8 1.5 8 1.5z',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  frame: 'M5 1.5v13M11 1.5v13M1.5 5h13M1.5 11h13',
  vector: 'M3 3h2v2H3zM11 11h2v2h-2zM4 5v7h7M5 4h7v7',
  edit: 'M10.5 2.5l3 3M3 10l8-8 3 3-8 8-4 1z',
  more: 'M3 8h.1M8 8h.1M13 8h.1',
  reset: 'M6 3H3v3M3.5 4.5a5 5 0 1 1-.3 6',
  'chevron-right': 'M6 3l5 5-5 5',
};

export function DesignIcon({ name, size = 16 }: { name: DesignIconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>;
}

/** A disabled control must never look broken: `disabledReason` turns its tooltip into the why. */
export function disabledTitle(label: string, disabledReason?: string) {
  return disabledReason ? `${label} — ${disabledReason}` : label;
}

export function DesignIconButton({ icon, label, onClick, pressed, disabled, disabledReason, className = '' }: {
  icon: DesignIconName; label: string; onClick?: () => void; pressed?: boolean; disabled?: boolean;
  /** Shown in the tooltip when the button is disabled, so it reads as unavailable rather than broken. */
  disabledReason?: string; className?: string;
}) {
  const title = disabled ? disabledTitle(label, disabledReason) : label;
  return <button type="button" className={`di-icon-button ${className}`} aria-label={label} title={title} aria-pressed={pressed} disabled={disabled} onClick={onClick}><DesignIcon name={icon} /></button>;
}

export function DesignSectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="di-section-head"><h3>{title}</h3>{children && <div className="di-head-actions">{children}</div>}</div>;
}

const formatValue = (value: number) => String(Number(value.toFixed(3)));
const parseValue = (text: string, current: number) => {
  const source = text.trim();
  // A typed negative position is absolute; x-10 remains available for subtraction.
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source)) return Number(source);
  return evaluateNumericExpression(source, current)?.value ?? null;
};

/** Compact expression-aware field. Escape cancels; arrows step; blur/Enter commit once. */
export function DesignNumberField({ label, prefix, icon, suffix, value, min, max, disabled, disabledReason, onCommit }: {
  label: string; prefix?: string; icon?: DesignIconName; suffix?: string;
  value: number; min?: number; max?: number; disabled?: boolean;
  /** Shown in the tooltip when the field is disabled, so it reads as unavailable rather than broken. */
  disabledReason?: string; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(formatValue(value));
  const editing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(formatValue(value)); }, [value]);
  const commit = () => {
    editing.current = false;
    if (cancelled.current) { cancelled.current = false; setDraft(formatValue(value)); return; }
    if (draft.trim() === formatValue(value)) return;
    const result = parseValue(draft, value);
    if (result === null || !Number.isFinite(result) || (min !== undefined && result < min) || (max !== undefined && result > max)) {
      setDraft(formatValue(value));
      return;
    }
    if (Math.abs(result - value) > 1e-9) onCommit(result);
    setDraft(formatValue(result));
  };
  return (
    <label className={`di-number-field${disabled ? ' is-disabled' : ''}`} title={disabled ? disabledTitle(label, disabledReason) : label}>
      <span className="di-field-prefix" aria-hidden="true">{icon ? <DesignIcon name={icon} size={14} /> : prefix}</span>
      <input
        type="text" inputMode="decimal" role="spinbutton" autoComplete="off" spellCheck={false}
        aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
        title={disabled ? disabledTitle(label, disabledReason) : undefined}
        value={editing.current ? draft : formatValue(value)} disabled={disabled}
        onFocus={(event) => { editing.current = true; cancelled.current = false; setDraft(formatValue(value)); event.currentTarget.select(); }}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; event.currentTarget.blur(); }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const current = parseValue(draft, value) ?? value;
            const step = (event.shiftKey ? 10 : event.altKey ? 0.1 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
            const next = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, current + step));
            setDraft(formatValue(next));
          }
        }}
      />
      {suffix && <span className="di-field-suffix" aria-hidden="true">{suffix}</span>}
    </label>
  );
}

const ALIGNMENTS: Array<{ icon: ObjectAlignment; label: string }> = [
  { icon: 'left', label: 'Align left' }, { icon: 'center-x', label: 'Align horizontal centers' }, { icon: 'right', label: 'Align right' },
  { icon: 'top', label: 'Align top' }, { icon: 'center-y', label: 'Align vertical centers' }, { icon: 'bottom', label: 'Align bottom' },
];

export function DesignAlignment({ onAlign, onDistribute, disabled, disabledReason, distributeDisabledReason }: {
  onAlign: (alignment: ObjectAlignment) => void; onDistribute?: () => void; disabled?: boolean;
  /** Tooltip suffix explaining why the alignment buttons are unavailable. */
  disabledReason?: string;
  /** Tooltip suffix explaining why distribution is unavailable. Falls back to `disabledReason`. */
  distributeDisabledReason?: string;
}) {
  const distributeDisabled = disabled || !onDistribute;
  return <div className="di-control-block"><span className="di-label">Alignment</span><div className="di-alignment-row" role="group" aria-label="Alignment">
    <div className="di-segment-group">{ALIGNMENTS.slice(0, 3).map(({ icon, label }) => <DesignIconButton key={icon} icon={icon} label={label} onClick={() => onAlign(icon)} disabled={disabled} disabledReason={disabledReason} />)}</div>
    <div className="di-segment-group">{ALIGNMENTS.slice(3).map(({ icon, label }) => <DesignIconButton key={icon} icon={icon} label={label} onClick={() => onAlign(icon)} disabled={disabled} disabledReason={disabledReason} />)}</div>
    <DesignIconButton icon="distribute-y" label="Distribute vertically" onClick={onDistribute} disabled={distributeDisabled} disabledReason={distributeDisabledReason ?? disabledReason} />
  </div></div>;
}

/** Arrangement is a one-shot geometry operation, not a persistent auto-layout setting. */
export function DesignFlow({ onArrange, disabled, disabledReason }: {
  onArrange: (mode: 'horizontal' | 'vertical' | 'grid') => void; disabled?: boolean;
  /** Tooltip suffix explaining why the arrange buttons are unavailable. */
  disabledReason?: string;
}) {
  return <div className="di-control-block"><span className="di-label">Flow</span><div className="di-flow-row" role="group" aria-label="Arrange layout">
    <span className="di-freeform" role="img" aria-label="Freeform layout" title="Freeform layout"><DesignIcon name="freeform" /></span>
    <DesignIconButton icon="vertical" label="Arrange vertically" onClick={() => onArrange('vertical')} disabled={disabled} disabledReason={disabledReason} />
    <DesignIconButton icon="horizontal" label="Arrange horizontally" onClick={() => onArrange('horizontal')} disabled={disabled} disabledReason={disabledReason} />
    <DesignIconButton icon="grid" label="Arrange in a grid" onClick={() => onArrange('grid')} disabled={disabled} disabledReason={disabledReason} />
  </div></div>;
}
