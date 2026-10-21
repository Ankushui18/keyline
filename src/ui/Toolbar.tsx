import { contrastTextColor } from './contrast-color';
import { useEffect, useRef, useState } from 'react';
import { framePresetGroups, framePresetSize } from '../core/frame-presets';
import { RedoIcon } from '@primer/octicons-react/RedoIcon';
import { UndoIcon } from '@primer/octicons-react/UndoIcon';
import { BrandMark } from '../design-system/BrandMark';

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
  onOpenSet: () => void;
  /** Creates a frame from any entry point: preset size, custom size, or a named preset. */
  onAddFrame: (width: number, height: number, name?: string) => void;
  onAddText: () => void;
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
  onOpenSet,
  onAddFrame,
  onAddText,
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

  const createFrame = (width: number, height: number, name?: string) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    onAddFrame(width, height, name);
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
          <BrandMark size={28} />
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
          <button type="button" className="topbar-icon" aria-label="Undo" title={`Undo (${MODIFIER_LABEL} Z)`} disabled={!canUndo} onClick={onUndo}><UndoIcon size={16} /></button>
          <button type="button" className="topbar-icon" aria-label="Redo" title={`Redo (${MODIFIER_LABEL} Shift Z)`} disabled={!canRedo} onClick={onRedo}><RedoIcon size={16} /></button>
        </div>
      </div>

      <div className="topbar-right">
        {collaborators.length > 0 && (
          <div className="topbar-people" role="status" aria-live="polite" aria-label={`${collaborators.length} collaborators online`}>
            {collaborators.slice(0, 3).map((presence) => (
              <span key={presence.clientId} style={{ background: presence.user.color, color: contrastTextColor(presence.user.color) }} title={presence.user.name}>
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
        <div className="topbar-frame" ref={frameMenuRef}>
          <button type="button" className="topbar-icon" aria-label="More" title="More: search, frames, set, motion, check, settings" aria-haspopup="menu" aria-expanded={frameMenuOpen} onClick={() => { setFrameMenuOpen((open) => !open); setCustomOpen(false); }}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
          </button>
          {frameMenuOpen && (
            <div className="topbar-frame-menu topbar-more-menu" role="menu" aria-label="More">
              <button type="button" role="menuitem" onClick={() => { setFrameMenuOpen(false); onOpenCommand(); }}><strong>Search or ask</strong><span>{MODIFIER_LABEL} K</span></button>
              <button type="button" role="menuitem" aria-label="Add text" onClick={() => { setFrameMenuOpen(false); onAddText(); }}><strong>Add text</strong><span>Center of the frame</span></button>
              <button type="button" role="menuitem" disabled={isEmpty} onClick={() => { setFrameMenuOpen(false); onOpenSet(); }}><strong>Set</strong><span>All icons together</span></button>
              <button type="button" role="menuitem" disabled={isEmpty} onClick={() => { setFrameMenuOpen(false); onOpenMotion(); }}><strong>Motion</strong><span>M</span></button>
              <button type="button" role="menuitem" disabled={isEmpty} onClick={() => { setFrameMenuOpen(false); onOpenCheck(); }}><strong>Check consistency</strong><span>{MODIFIER_LABEL} ⇧ C</span></button>
              <hr />
              {framePresetGroups().map(({ group, presets }) => (
                <div key={group} className="topbar-frame-group" role="group" aria-label={`${group} frames`}>
                  <span className="topbar-frame-group-label">{group}</span>
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitem"
                      aria-label={`New ${preset.label} frame ${framePresetSize(preset)}`}
                      onClick={() => createFrame(preset.width, preset.height, preset.name)}
                    >
                      <strong>{preset.label}</strong>
                      <span>{framePresetSize(preset)}</span>
                    </button>
                  ))}
                </div>
              ))}
              <button type="button" role="menuitem" aria-expanded={customOpen} onClick={() => setCustomOpen((open) => !open)}>
                <strong>New custom frame…</strong>
                <span>Set width and height</span>
              </button>
              {customOpen && (
                <div className="topbar-frame-custom" role="group" aria-label="Custom icon frame size">
                  <label><span>W</span><input aria-label="Custom frame width" type="number" min="1" value={customWidth} onChange={(event) => setCustomWidth(Number(event.target.value))} /></label>
                  <label><span>H</span><input aria-label="Custom frame height" type="number" min="1" value={customHeight} onChange={(event) => setCustomHeight(Number(event.target.value))} /></label>
                  <button type="button" onClick={() => createFrame(customWidth, customHeight)}>Create</button>
                </div>
              )}
              <hr />
              <button type="button" role="menuitem" onClick={() => { setFrameMenuOpen(false); onOpenSettings(); }}><strong>Settings</strong><span>Shortcuts, grid, AI</span></button>
            </div>
          )}
        </div>
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
