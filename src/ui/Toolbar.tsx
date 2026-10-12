import { useEffect, useRef, useState } from 'react';
import { PlusIcon } from '@primer/octicons-react/PlusIcon';
import { RedoIcon } from '@primer/octicons-react/RedoIcon';
import { UndoIcon } from '@primer/octicons-react/UndoIcon';

interface ToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  documentName: string;
  onRenameDocument: (name: string) => void;
  /** True while the drawing has no artwork yet, so actions that need artwork are off. */
  isEmpty: boolean;
  saveStatus: 'saved' | 'saving' | 'error';
  constraintCount: number;
  constraintsOpen: boolean;
  solverStatus: 'loading' | 'ready' | 'error';
  collaborationStatus: 'connecting' | 'synced' | 'offline' | 'error' | null;
  collaborators: Array<{ clientId: number; user: { id: string; name: string; color: string } }>;
  onHome: () => void;
  onShare: () => void;
  onOpenSettings: () => void;
  onOpenCommand: () => void;
  onOpenMotion: () => void;
  onOpenCheck: () => void;
  onAddIconFrame: (width: number, height: number) => void;
  onToggleConstraints: () => void;
  onExport: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
export const MODIFIER_LABEL = isMac ? '⌘' : 'Ctrl';

export function Toolbar({
  canUndo,
  canRedo,
  documentName,
  onRenameDocument,
  isEmpty,
  saveStatus,
  constraintCount,
  constraintsOpen,
  solverStatus,
  collaborationStatus,
  collaborators,
  onHome,
  onShare,
  onOpenSettings,
  onOpenCommand,
  onOpenMotion,
  onOpenCheck,
  onAddIconFrame,
  onToggleConstraints,
  onExport,
  onUndo,
  onRedo,
}: ToolbarProps) {
  const [frameMenuOpen, setFrameMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customWidth, setCustomWidth] = useState(24);
  const [customHeight, setCustomHeight] = useState(24);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(documentName);
  const frameMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!frameMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!frameMenuRef.current?.contains(event.target as Node)) {
        setFrameMenuOpen(false);
        setCustomOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setFrameMenuOpen(false);
      setCustomOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [frameMenuOpen]);

  const createFrame = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    onAddIconFrame(width, height);
    setFrameMenuOpen(false);
    setCustomOpen(false);
  };
  const commitName = () => {
    setEditingName(false);
    if (nameDraft.trim() && nameDraft.trim() !== documentName) onRenameDocument(nameDraft.trim());
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="topbar-brand" aria-label="Back to all files" title="All files" onClick={onHome}>
          <svg viewBox="0 0 64 64" role="img" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="#26272b" />
            <rect x="14" y="14" width="36" height="36" fill="none" stroke="#ececee" strokeWidth="3.5" />
            <circle cx="32" cy="32" r="18" fill="none" stroke="#ececee" strokeWidth="3.5" />
            <rect x="44" y="8" width="12" height="12" fill="#0d99ff" />
          </svg>
          <strong>Keyline</strong>
        </button>
        <span className="topbar-divider" aria-hidden="true" />
        {editingName ? (
          <input
            className="topbar-name-input"
            autoFocus
            value={nameDraft}
            aria-label="File name"
            maxLength={80}
            onChange={(event) => setNameDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitName();
              if (event.key === 'Escape') { event.stopPropagation(); setEditingName(false); }
            }}
          />
        ) : (
          <button type="button" className="topbar-name" title="Rename file" onClick={() => { setNameDraft(documentName); setEditingName(true); }}>{documentName}</button>
        )}
        <span className={`topbar-save is-${saveStatus}`} role="status"><i />{saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Could not save' : 'Saved'}</span>
        <div className="topbar-group" role="group" aria-label="History">
          <button type="button" className="topbar-icon" aria-label="Undo" title={`Undo (${MODIFIER_LABEL} Z)`} disabled={!canUndo} onClick={onUndo}><UndoIcon size={17} /></button>
          <button type="button" className="topbar-icon" aria-label="Redo" title={`Redo (${MODIFIER_LABEL} Shift Z)`} disabled={!canRedo} onClick={onRedo}><RedoIcon size={17} /></button>
        </div>
        <div className="topbar-frame" ref={frameMenuRef}>
          <button type="button" className="topbar-text-button" aria-haspopup="dialog" aria-expanded={frameMenuOpen} onClick={() => { setFrameMenuOpen((open) => !open); setCustomOpen(false); }}>
            <PlusIcon size={14} />
            Frame
          </button>
          {frameMenuOpen && (
            <div className="topbar-frame-menu" role="dialog" aria-label="Add icon frame size">
              {[24, 32, 48].map((size) => (
                <button key={size} type="button" onClick={() => createFrame(size, size)}>
                  <strong>{size}×{size}</strong>
                  <span>{size === 24 ? 'Interface icon' : size === 32 ? 'Product icon' : 'Large icon'}</span>
                </button>
              ))}
              <button type="button" aria-expanded={customOpen} onClick={() => setCustomOpen((open) => !open)}>
                <strong>Custom…</strong>
                <span>Set width and height</span>
              </button>
              {customOpen && (
                <div className="topbar-frame-custom" role="group" aria-label="Custom icon frame size">
                  <label><span>W</span><input aria-label="Custom frame width" type="number" min="1" value={customWidth} onChange={(event) => setCustomWidth(Number(event.target.value))} /></label>
                  <label><span>H</span><input aria-label="Custom frame height" type="number" min="1" value={customHeight} onChange={(event) => setCustomHeight(Number(event.target.value))} /></label>
                  <button type="button" onClick={() => createFrame(customWidth, customHeight)}>Create</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="topbar-right">
        <button type="button" className="topbar-command" onClick={onOpenCommand} title="Search every action, or ask for an edit">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
          Search or ask
          <kbd>{MODIFIER_LABEL} K</kbd>
        </button>
        <button type="button" className="topbar-text-button" disabled={isEmpty} title="Animate this drawing (M)" onClick={onOpenMotion}>Motion</button>
        <button type="button" className="topbar-text-button" disabled={isEmpty} title={`Check icons are consistent (${MODIFIER_LABEL} Shift C)`} onClick={onOpenCheck}>Check</button>
        <button type="button" className="topbar-icon" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></svg>
        </button>
        {collaborators.length > 0 && (
          <div className="topbar-people" role="status" aria-live="polite" aria-label={`${collaborators.length} collaborators online`}>
            {collaborators.slice(0, 3).map((presence) => (
              <span key={presence.clientId} style={{ background: presence.user.color }} title={presence.user.name}>
                {presence.user.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
              </span>
            ))}
          </div>
        )}
        <button type="button" className={`topbar-share status-${collaborationStatus ?? 'idle'}`} onClick={onShare} title="Share a live link">
          <i />
          {collaborationStatus === 'synced' ? 'Shared' : collaborationStatus ?? 'Share'}
        </button>
        <button type="button" className="topbar-export" disabled={isEmpty} onClick={onExport} title="Export SVG or code">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></svg>
          Export
        </button>
      </div>

      <button
        type="button"
        className={`constraints-button ${constraintsOpen ? 'is-active' : ''}`}
        aria-label="Constraints"
        aria-pressed={constraintsOpen}
        onClick={onToggleConstraints}
        title={`Constraints, ${constraintCount} in this file (K)`}
      >
        <svg className="constraints-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 5v14M19 5v14" />
          <path d="M5 12h14" strokeDasharray="2 3" />
        </svg>
        <span className={`solver-dot is-${solverStatus}`} />
        <span className="constraints-label">Constraints</span>
        <b>{constraintCount}</b>
      </button>
    </header>
  );
}
