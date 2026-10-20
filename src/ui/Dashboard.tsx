import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseDocumentBackup } from '../core/document-backup';
import { createEntityId } from '../core/ids';
import type { DocumentSnapshot } from '../core/types';
import {
  deleteStoredDocument,
  duplicateStoredDocument,
  listDocuments,
  renameStoredDocument,
  type DocumentSummary,
} from '../core/store';
import { BrandMark } from '../design-system/BrandMark';

export type StartAction =
  | { kind: 'blank' }
  | { kind: 'icon'; size: number }
  | { kind: 'logo'; width: number; height: number }
  | { kind: 'sample' }
  | { kind: 'svg'; source: string; name: string }
  | { kind: 'backup'; snapshot: DocumentSnapshot; name: string };

type Filter = 'all' | 'icons' | 'logo' | 'imported';
const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['icons', 'Icon sets'], ['logo', 'Logos'], ['imported', 'Imported']];
const UNDO_WINDOW_MS = 6000;

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

export function Dashboard({
  onOpen,
  onStart,
}: {
  onOpen: (id: string) => void;
  onStart: (action: StartAction) => void | Promise<void>;
}) {
  const [files, setFiles] = useState<DocumentSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<DocumentSummary | null>(null);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteTimer = useRef<number | undefined>(undefined);
  const pendingDeleteRef = useRef<DocumentSummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await listDocuments());
    } catch {
      setFiles([]);
      setMessage('Could not read files saved on this device.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const commitDelete = useCallback(async () => {
    window.clearTimeout(deleteTimer.current);
    const target = pendingDeleteRef.current;
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    if (target) await deleteStoredDocument(target.id).catch(() => undefined);
  }, []);

  // A delete that was not undone must still happen if the person leaves the page.
  useEffect(() => () => { void commitDelete(); }, [commitDelete]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') {
        setMenuId(null);
        setRenamingId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!menuId) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('.dashboard-menu, .dashboard-file-menu-button')) setMenuId(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuId]);

  const readImportFile = useCallback(async (file: File) => {
    const lower = file.name.toLowerCase();
    const isSvg = file.type === 'image/svg+xml' || lower.endsWith('.svg');
    const isBackup = file.type === 'application/json' || lower.endsWith('.json');
    if (!isSvg && !isBackup) {
      setMessage('Drop an SVG or a .keyline.json backup to import it.');
      return;
    }
    try {
      const source = await file.text();
      if (isBackup) {
        // Parse before leaving the dashboard so a bad file gets a readable message here.
        const backup = parseDocumentBackup(source, file.name);
        try {
          await onStart({ kind: 'backup', ...backup });
        } catch {
          throw new Error('Could not restore that backup. Browser storage may be full.');
        }
      } else {
        await onStart({ kind: 'svg', source, name: file.name });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not import ${file.name}.`);
    }
  }, [onStart]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (files ?? [])
      .filter((file) => file.id !== pendingDelete?.id)
      .filter((file) => filter === 'all' || file.kind === filter)
      .filter((file) => !needle || file.name.toLowerCase().includes(needle));
  }, [files, filter, pendingDelete, query]);

  const startRename = (file: DocumentSummary) => {
    setMenuId(null);
    setRenamingId(file.id);
    setRenameValue(file.name);
  };
  const finishRename = async (file: DocumentSummary, save: boolean) => {
    setRenamingId(null);
    if (!save || !renameValue.trim() || renameValue.trim() === file.name) return;
    await renameStoredDocument(file.id, renameValue);
    await refresh();
  };
  const duplicate = async (file: DocumentSummary) => {
    setMenuId(null);
    await duplicateStoredDocument(file.id, createEntityId());
    await refresh();
  };
  const requestDelete = async (file: DocumentSummary) => {
    setMenuId(null);
    await commitDelete();
    pendingDeleteRef.current = file;
    setPendingDelete(file);
    deleteTimer.current = window.setTimeout(() => { void commitDelete().then(refresh); }, UNDO_WINDOW_MS);
  };
  const undoDelete = () => {
    window.clearTimeout(deleteTimer.current);
    pendingDeleteRef.current = null;
    setPendingDelete(null);
  };

  const hasFiles = (files?.length ?? 0) > 0;

  return (
    <div
      className={`dashboard${dragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = [...event.dataTransfer.files][0];
        if (file) void readImportFile(file);
      }}
    >
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <BrandMark size={28} label="Keyline" />
          <strong>Keyline</strong>
        </div>
        <label className="dashboard-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your files" aria-label="Search your files" />
          <kbd>/</kbd>
        </label>
        <span className="dashboard-spacer" />
        <span className="dashboard-device-note">Saved on this device</span>
        <input ref={fileInputRef} type="file" accept="image/svg+xml,.svg,application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readImportFile(file); event.target.value = ''; }} />
        <button type="button" className="dashboard-button" onClick={() => fileInputRef.current?.click()}>Import</button>
        <button type="button" className="dashboard-button is-primary" onClick={() => onStart({ kind: 'icon', size: 24 })}>New icon set</button>
      </header>

      <main className="dashboard-main">
        <section aria-label="Start something">
          <h2 className="dashboard-label">Start something</h2>
          <div className="dashboard-starts">
            <StartCard title="Icon set" detail="24 px frame" onClick={() => onStart({ kind: 'icon', size: 24 })}>
              <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 15 12 8l4 7" /></svg>
            </StartCard>
            <StartCard title="Logo or mark" detail="512 px square" onClick={() => onStart({ kind: 'logo', width: 512, height: 512 })}>
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M8 13c2 3 6 3 8 0" /></svg>
            </StartCard>
            <StartCard title="Import a file" detail="SVG or backup" dashed onClick={() => fileInputRef.current?.click()}>
              <svg viewBox="0 0 24 24"><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M5 15v4h14v-4" /></svg>
            </StartCard>
            <StartCard title="Open a sample" detail="Built with rules" onClick={() => onStart({ kind: 'sample' })}>
              <svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /></svg>
            </StartCard>
          </div>
        </section>

        <section aria-label="Your files" className="dashboard-files">
          <div className="dashboard-files-head">
            <h2 className="dashboard-label">Your files</h2>
            <div className="dashboard-tabs" role="tablist" aria-label="Filter files">
              {FILTERS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'is-active' : ''} onClick={() => setFilter(id)}>{label}</button>)}
            </div>
          </div>
          {files === null ? <p className="dashboard-note" role="status">Loading your files…</p> : !hasFiles ? (
            <div className="ui-empty ui-empty--framed"><strong>No files yet</strong><span>Start with an icon set or drop an SVG or backup anywhere on this page. Your work is saved here automatically.</span></div>
          ) : visible.length === 0 ? (
            <div className="ui-empty"><strong>Nothing matches</strong><span>{query ? `No file name contains “${query}”.` : 'No files of this type yet.'}</span></div>
          ) : (
            <div className="dashboard-grid">
              {visible.map((file, index) => (
                <article className="dashboard-file" key={file.id}>
                  <button type="button" className="dashboard-file-open" onClick={() => onOpen(file.id)} aria-label={`Open ${file.name}`} autoFocus={index === 0 && !query}>
                    <span className="dashboard-thumb">
                      {file.thumb
                        ? <img alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.thumb)}`} />
                        : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /></svg>}
                    </span>
                  </button>
                  <div className="dashboard-meta">
                    {renamingId === file.id ? (
                      <input
                        className="dashboard-rename"
                        autoFocus
                        value={renameValue}
                        aria-label="File name"
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={() => void finishRename(file, true)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void finishRename(file, true);
                          if (event.key === 'Escape') { event.stopPropagation(); void finishRename(file, false); }
                        }}
                      />
                    ) : <strong>{file.name}</strong>}
                    <span>Edited {formatRelativeTime(file.updatedAt)} · {file.artboardCount} {file.artboardCount === 1 ? 'icon' : 'icons'}{file.kind === 'imported' ? ' · imported' : ''}</span>
                  </div>
                  <button type="button" className="dashboard-file-menu-button" aria-label={`Menu for ${file.name}`} aria-haspopup="menu" aria-expanded={menuId === file.id} onClick={() => setMenuId(menuId === file.id ? null : file.id)}>⋯</button>
                  {menuId === file.id && (
                    <div className="dashboard-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => startRename(file)}>Rename</button>
                      <button type="button" role="menuitem" onClick={() => void duplicate(file)}>Duplicate</button>
                      <button type="button" role="menuitem" className="is-danger" onClick={() => void requestDelete(file)}>Delete</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          <p className="dashboard-note">Files live on this device. Export or share a link to move them.</p>
        </section>
      </main>

      {(pendingDelete || message) && (
        <div className="dashboard-toast" role="status">
          <span>{pendingDelete ? `Deleted “${pendingDelete.name}”` : message}</span>
          {pendingDelete ? <button type="button" onClick={undoDelete}>Undo</button> : <button type="button" onClick={() => setMessage(null)}>Dismiss</button>}
        </div>
      )}
      {dragging && <div className="dashboard-drop" aria-hidden="true"><strong>Drop to import this SVG</strong></div>}
    </div>
  );
}

function StartCard({ title, detail, dashed, onClick, children }: { title: string; detail: string; dashed?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`dashboard-start${dashed ? ' is-dashed' : ''}`} onClick={onClick}>
      {children}
      <span><strong>{title}</strong><small>{detail}</small></span>
    </button>
  );
}
