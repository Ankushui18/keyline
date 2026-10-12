import type { ConstraintConflict, EntityId } from '../core/types';

interface ConstraintDiagnosticsProps {
  conflicts: ConstraintConflict[];
  onDrop: (constraintId: EntityId) => void;
  onRelax: (constraintId: EntityId) => void;
  onAdjust: (constraintId: EntityId) => void;
  onDismiss: () => void;
}

export function ConstraintDiagnostics({ conflicts, onDrop, onRelax, onAdjust, onDismiss }: ConstraintDiagnosticsProps) {
  if (conflicts.length === 0) return null;
  return (
    <section className="diagnostics-panel" aria-label="Constraint diagnostics">
      <div className="diagnostics-heading">
        <span className="diagnostic-alert">!</span>
        <div><strong>Constraint conflict</strong><span>{conflicts.length} issue{conflicts.length === 1 ? '' : 's'} blocked the last action</span></div>
        <button onClick={onDismiss} aria-label="Dismiss diagnostics">×</button>
      </div>
      <div className="diagnostic-list">
        {conflicts.map((conflict, index) => {
          const primary = conflict.constraintIds[0];
          return (
            <article key={`${conflict.constraintIds.join(':')}:${index}`}>
              <div className="diagnostic-copy">
                <strong>{conflict.message}</strong>
                <span>Error {formatError(conflict.error)} · {conflict.suggestion}</span>
                <code>{conflict.constraintIds.map(shortId).join(' ↔ ') || 'solver'}</code>
              </div>
              {primary && (
                <div className="diagnostic-actions">
                  <button onClick={() => onDrop(primary)}>Drop constraint</button>
                  <button onClick={() => onRelax(primary)}>Relax to soft</button>
                  <button onClick={() => onAdjust(primary)}>Adjust parameter</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

const shortId = (id: string): string => id.slice(-6).toUpperCase();
const formatError = (value: number): string => Number.isFinite(value) ? value.toExponential(2) : '∞';
