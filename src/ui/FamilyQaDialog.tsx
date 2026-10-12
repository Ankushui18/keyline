import { useEffect, useRef, useState } from 'react';
import type { VectorDocument } from '../core/document';
import { auditGeometryComponent, type FamilyQaReport } from '../core/family-qa';
import type { EntityId } from '../core/types';

export function FamilyQaDialog({
  document,
  componentId,
  onCancel,
  onReviewTopology,
  onApply,
}: {
  document: VectorDocument;
  componentId: EntityId;
  onCancel: () => void;
  onReviewTopology: () => void;
  onApply: (issueIds: string[]) => Promise<void>;
}) {
  const report: FamilyQaReport | null = auditGeometryComponent(document, componentId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [applying, setApplying] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeButtonRef.current?.focus(), []);
  if (!report) return null;
  const selectedCount = report.issues.filter((issue) => selectedIds.has(issue.id) && issue.fix).length;
  const topologyCount = report.issues.filter((issue) => issue.requiresTopologyReview).length;
  const toggleAll = (checked: boolean) => setSelectedIds(new Set(checked
    ? report.issues
      .filter((issue) => issue.fix && !document.isObjectLocked(issue.objectId))
      .map((issue) => issue.id)
    : []));

  return (
    <div className="shared-style-impact-backdrop" onPointerDown={(event) => {
      if (event.currentTarget === event.target) onCancel();
    }}>
      <section
        ref={dialogRef}
        className="shared-style-impact-dialog family-qa-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="family-qa-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !applying) {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ) ?? [])].filter((element) => element.offsetParent !== null);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && window.document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && window.document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <div>
            <span className="eyebrow">FAMILY PREFLIGHT</span>
            <h2 id="family-qa-title">QA · {report.component.name}</h2>
            <p>{report.memberCount} members · {report.errorCount} errors · {report.warningCount} warnings</p>
          </div>
          <button ref={closeButtonRef} type="button" className="impact-close" aria-label="Close family QA" onClick={onCancel}>×</button>
        </header>
        <div className="family-qa-content">
          <div className={`family-qa-summary ${report.passed ? 'is-pass' : 'has-findings'}`} role="status">
            <strong>{report.passed ? 'Ready for delivery' : `${report.issues.length} ${report.issues.length === 1 ? 'finding' : 'findings'} to review`}</strong>
            <span>{report.passed
              ? 'Naming, dimensions, stroke rules, topology, and artboard bounds are consistent.'
              : 'Choose safe fixes explicitly. Intentional variants remain untouched unless selected.'}</span>
          </div>
          {report.issues.length > 0 && (
            <div className="family-qa-toolbar">
              <span>{selectedCount} safe {selectedCount === 1 ? 'fix' : 'fixes'} selected</span>
              <div className="inline-button-row">
                <button type="button" onClick={() => toggleAll(true)}>Select safe fixes</button>
                <button type="button" onClick={() => toggleAll(false)}>Clear</button>
              </div>
            </div>
          )}
          <div className="family-qa-list">
            {report.issues.map((issue) => {
              const locked = document.isObjectLocked(issue.objectId);
              return (
                <article className={`family-qa-row is-${issue.severity}`} key={issue.id}>
                  {issue.fix ? (
                    <input
                      type="checkbox"
                      aria-label={`Apply fix: ${issue.fixLabel} for ${issue.objectName}`}
                      checked={selectedIds.has(issue.id)}
                      disabled={locked || applying}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (checked) next.add(issue.id);
                          else next.delete(issue.id);
                          return next;
                        });
                      }}
                    />
                  ) : <span className="family-qa-unfixable" aria-hidden="true">!</span>}
                  <div>
                    <span className="family-qa-meta">{issue.severity} · {issue.category}</span>
                    <strong>{issue.title}</strong>
                    <span>{issue.objectName} · {issue.detail}</span>
                    {issue.fixLabel && <small>{locked ? 'Locked member — unlock to apply' : issue.fixLabel}</small>}
                  </div>
                  {issue.requiresTopologyReview && (
                    <button type="button" onClick={onReviewTopology}>Review topology</button>
                  )}
                </article>
              );
            })}
          </div>
        </div>
        <footer>
          <p>{topologyCount > 0 ? `${topologyCount} topology ${topologyCount === 1 ? 'conflict requires' : 'conflicts require'} deliberate review.` : 'Selected fixes are grouped into one Undo step.'}</p>
          <div>
            <button type="button" disabled={applying} onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className="impact-apply"
              disabled={selectedCount === 0 || applying}
              onClick={async () => {
                setApplying(true);
                await onApply([...selectedIds]);
                setApplying(false);
              }}
            >{applying ? 'Applying…' : `Apply ${selectedCount} selected`}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

