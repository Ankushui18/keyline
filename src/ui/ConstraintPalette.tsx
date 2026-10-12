import { useEffect, useMemo, useRef, useState } from 'react';
import { constraintActions } from '../constraints/catalog';
import type { VectorDocument } from '../core/document';
import type { ConstraintType, SelectionState } from '../core/types';

interface ConstraintPaletteProps {
  document: VectorDocument;
  selection: SelectionState;
  solverStatus: 'loading' | 'ready' | 'error';
  onApply: (type: ConstraintType, value?: number) => void;
  onClose: () => void;
}

export function ConstraintPalette({
  document,
  selection,
  solverStatus,
  onApply,
  onClose,
}: ConstraintPaletteProps) {
  const actions = useMemo(() => constraintActions(document, selection), [document, selection]);
  const [distance, setDistance] = useState('20');
  const [angle] = useState('90');
  const [radius] = useState('20');
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = window.document.activeElement instanceof HTMLElement
      ? window.document.activeElement
      : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const parameter = (type: ConstraintType): number | undefined => {
    if (type === 'fixed_distance') return finite(distance, 20);
    if (type === 'fixed_angle') return finite(angle, 90);
    if (type === 'fixed_radius') return finite(radius, 20);
    return undefined;
  };

  const actionByType = new Map(actions.map((action) => [action.type, action]));
  const cards: Array<{ type: ConstraintType; label: string; description: string; diagram: string }> = [
    { type: 'parallel', label: 'Parallel', description: 'Lines keep the same direction', diagram: 'parallel' },
    { type: 'perpendicular', label: 'Perpendicular', description: 'Lines meet at a right angle', diagram: 'perpendicular' },
    { type: 'equal_length', label: 'Equal length', description: 'Both lines stay the same length', diagram: 'equal' },
    { type: 'vertical', label: 'Vertical', description: 'Both lines stay straight up', diagram: 'vertical' },
    { type: 'tangent', label: 'Tangent', description: 'Needs one line and one arc', diagram: 'tangent' },
    { type: 'fixed_distance', label: 'Length', description: '', diagram: 'length' },
  ];
  const selectionSummary = selection.segmentIds.size === 2
    ? '2 lines selected. Only rules that fit are shown.'
    : `${selection.nodeIds.size} point${selection.nodeIds.size === 1 ? '' : 's'} and ${selection.segmentIds.size} line${selection.segmentIds.size === 1 ? '' : 's'} selected. Only rules that fit are shown.`;

  return (
    <>
      <button className="constraint-palette-scrim" aria-label="Dismiss constraint palette" onClick={onClose} />
      <section className="constraint-palette keyline-constraint-picker" role="dialog" aria-modal="false" aria-labelledby="constraint-picker-title">
        <header role="presentation">
          <div>
            <h2 id="constraint-picker-title">Lock a rule</h2>
            <p>{selectionSummary}</p>
          </div>
          <button ref={closeRef} className="palette-close" onClick={onClose} aria-label="Close constraint palette">×</button>
        </header>
        <div className="keyline-constraint-grid">
          {cards.map((card) => {
            const action = actionByType.get(card.type);
            const enabled = Boolean(action?.enabled);
            return (
              <div
                key={card.type}
                className={`keyline-constraint-card diagram-${card.diagram}${enabled ? '' : ' is-disabled'}`}
                role={card.type === 'fixed_distance' ? undefined : 'button'}
                tabIndex={enabled && card.type !== 'fixed_distance' ? 0 : undefined}
                aria-disabled={!enabled}
                title={enabled ? card.label : action?.reason}
                onClick={() => { if (enabled && card.type !== 'fixed_distance') onApply(card.type, parameter(card.type)); }}
                onKeyDown={(event) => {
                  if (enabled && card.type !== 'fixed_distance' && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onApply(card.type, parameter(card.type));
                  }
                }}
              >
                <ConstraintDiagram kind={card.diagram} />
                <strong>{card.label}</strong>
                {card.type === 'fixed_distance' ? (
                  <label onClick={(event) => event.stopPropagation()}>
                    <input aria-label="Length" type="number" min="0" step="1" value={distance} onChange={(event) => setDistance(event.target.value)} onKeyDown={(event) => { if (enabled && event.key === 'Enter') onApply(card.type, parameter(card.type)); }} />
                    <span>px</span>
                  </label>
                ) : <small>{card.description}</small>}
              </div>
            );
          })}
        </div>
        <div className="constraint-actions constraint-compatibility-actions" aria-label="All constraint actions">
          {actions.map((action) => (
            <button key={action.type} type="button" disabled={!action.enabled} title={action.enabled ? action.label : action.reason} onClick={() => onApply(action.type, parameter(action.type))}>
              {action.label}
            </button>
          ))}
        </div>
        <footer role="presentation">
          <strong>Preview</strong>
          <p>Hover a rule to see the canvas change before you lock it. If a rule cannot be applied, we say which existing rule is in the way.</p>
          <span className={`solver-chip is-${solverStatus}`} role="status" aria-label={`Solver ${solverStatus}`}><i /></span>
        </footer>
      </section>
    </>
  );
}

interface ConstraintContextMenuProps {
  x: number;
  y: number;
  document: VectorDocument;
  selection: SelectionState;
  onApply: (type: ConstraintType) => void;
  onClose: () => void;
}

export function ConstraintContextMenu({ x, y, document, selection, onApply, onClose }: ConstraintContextMenuProps) {
  const actions = constraintActions(document, selection).filter((action) => action.enabled);
  return (
    <>
      <button className="context-menu-scrim" aria-label="Close context menu" onClick={onClose} />
      <div className="constraint-context-menu" style={{ left: x, top: y }} role="menu">
        <span>Apply constraint</span>
        {actions.length > 0 ? actions.map((action) => (
          <button key={action.type} role="menuitem" onClick={() => { onApply(action.type); onClose(); }}>
            <i>{action.symbol}</i>{action.label}
          </button>
        )) : <p>Select compatible nodes or segments first.</p>}
      </div>
    </>
  );
}

function ConstraintDiagram({ kind }: { kind: string }) {
  if (kind === 'parallel') return <svg viewBox="0 0 96 44" aria-hidden="true"><path className="muted" d="M16 31 63 15"/><path className="blue" d="m33 38 47-16"/></svg>;
  if (kind === 'perpendicular') return <svg viewBox="0 0 96 44" aria-hidden="true"><path className="muted" d="M22 34h62M54 34V6"/><path d="M54 25h9v9"/></svg>;
  if (kind === 'equal') return <svg viewBox="0 0 96 44" aria-hidden="true"><path className="muted" d="M18 14h52M18 32h52"/><path d="M80 10v8M76 14h8M80 28v8M76 32h8"/></svg>;
  if (kind === 'vertical') return <svg viewBox="0 0 96 44" aria-hidden="true"><path className="muted" d="M36 5v34"/><path className="blue" d="M66 5v34"/></svg>;
  if (kind === 'tangent') return <svg viewBox="0 0 96 44" aria-hidden="true"><path className="muted" d="M18 34h38c16 0 24-8 24-24"/></svg>;
  return <svg viewBox="0 0 96 44" aria-hidden="true"><path className="muted" d="M20 10h58M20 34h58"/><path className="blue" d="M20 6v32M78 6v32"/></svg>;
}

function finite(value: string, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
