import { useEffect, useMemo, useRef, useState } from 'react';
import { planQuickEdit, QUICK_EDIT_EXAMPLES, type QuickEditPlan, type QuickEditTarget } from '../core/quick-edit';

export interface CommandItem {
  id: string;
  label: string;
  group: 'Tools' | 'Actions' | 'Frames';
  shortcut?: string;
  keywords?: string;
  disabledReason?: string;
  run: () => void;
}

export function CommandBar({
  commands,
  targets,
  selectionLabel,
  onApplyEdit,
  onClose,
}: {
  commands: CommandItem[];
  targets: QuickEditTarget[];
  selectionLabel: string;
  onApplyEdit: (plan: QuickEditPlan) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const plan = useMemo(() => (query.trim() ? planQuickEdit(query, targets) : null), [query, targets]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    const words = needle.split(/\s+/);
    return commands
      .map((command) => {
        const haystack = `${command.label} ${command.keywords ?? ''} ${command.group}`.toLowerCase();
        if (!words.every((word) => haystack.includes(word))) return undefined;
        const label = command.label.toLowerCase();
        const score = label.startsWith(needle) ? 0 : label.includes(needle) ? 1 : 2;
        return { command, score };
      })
      .filter((entry): entry is { command: CommandItem; score: number } => entry !== undefined)
      .sort((a, b) => a.score - b.score)
      .map((entry) => entry.command);
  }, [commands, query]);

  type Row = { kind: 'edit'; plan: QuickEditPlan } | { kind: 'command'; command: CommandItem };
  const rows: Row[] = [
    ...(plan?.ok ? [{ kind: 'edit', plan } as Row] : []),
    ...matches.map((command): Row => ({ kind: 'command', command })),
  ];

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'edit') { onApplyEdit(row.plan); onClose(); return; }
    if (row.command.disabledReason) return;
    onClose();
    // Run after the bar has closed so dialogs it opens are not closed by its Escape handler.
    window.setTimeout(row.command.run, 0);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(rows.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(rows[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };

  const failure = plan && !plan.ok && matches.length === 0 ? plan.message : null;
  let lastGroup = '';

  return (
    <div className="modal-backdrop kd-backdrop is-top" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="kd-command" role="dialog" aria-modal="true" aria-label="Search or ask">
        <div className="kd-command-input">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="kd-command-list"
            aria-activedescendant={rows[active] ? `kd-row-${active}` : undefined}
            value={query}
            placeholder={`Search actions, or describe an edit: “${QUICK_EDIT_EXAMPLES[0]}”`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="kd-command-list" id="kd-command-list" role="listbox" ref={listRef}>
          {rows.map((row, index) => {
            if (row.kind === 'edit') {
              return (
                <div key="edit" id={`kd-row-${index}`} role="option" aria-selected={index === active} className={`kd-command-row is-edit${index === active ? ' is-active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => choose(row)}>
                  <div className="kd-command-group">Edit {selectionLabel}</div>
                  <div className="kd-edit-changes">
                    {row.plan.changes.map((change) => <div key={change.label}><span>{change.label}</span><b>{change.before} → {change.after}</b></div>)}
                  </div>
                  <small>Enter to apply · one undo step</small>
                </div>
              );
            }
            const { command } = row;
            const header = command.group !== lastGroup ? command.group : '';
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {header && <div className="kd-command-group">{header}</div>}
                <div id={`kd-row-${index}`} role="option" aria-selected={index === active} aria-disabled={Boolean(command.disabledReason)} title={command.disabledReason} className={`kd-command-row${index === active ? ' is-active' : ''}${command.disabledReason ? ' is-disabled' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => choose(row)}>
                  <span>{command.label}</span>
                  {command.disabledReason ? <small>{command.disabledReason}</small> : command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
                </div>
              </div>
            );
          })}
          {failure && <p className="kd-command-empty">{failure}</p>}
          {!failure && rows.length === 0 && <p className="kd-command-empty">Nothing matches “{query}”.</p>}
        </div>
      </section>
    </div>
  );
}
