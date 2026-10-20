import { useEffect, useState } from 'react';
import type { SaveStatus } from '../core/store';

interface StatusBarProps {
  nodeCount: number;
  segmentCount: number;
  pathCount: number;
  regionCount: number;
  constraintCount: number;
  solverStatus: 'loading' | 'ready' | 'error';
  zoom: number;
  saveStatus: SaveStatus;
  selectionLabel: string;
  shared?: boolean;
  onDownloadCopy?: () => void;
}

export function StatusBar({
  nodeCount,
  segmentCount,
  pathCount,
  regionCount,
  constraintCount,
  solverStatus,
  zoom,
  saveStatus,
  selectionLabel,
  shared = false,
  onDownloadCopy,
}: StatusBarProps) {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const offline = shared && !online && saveStatus !== 'error';
  return (
    <footer className="status-bar">
      <div className="status-group">
        <span className="status-selection">{selectionLabel}</span>
        <span className="status-metrics"><strong>{nodeCount}</strong> nodes · <strong>{segmentCount}</strong> segments · <strong>{pathCount}</strong> paths · <strong>{regionCount}</strong> regions · <span className="constraint-status"><b className={`is-${solverStatus}`} /><strong>{constraintCount}</strong> constraints</span></span>
      </div>
      <div className="status-group status-right">
        <span className={`save-state is-${offline ? 'offline' : saveStatus}`}><b />{offline ? 'Offline. Changes will sync when you’re back.' : saveLabel(saveStatus)}</span>
        {saveStatus === 'error' && onDownloadCopy && <button type="button" className="status-download" onClick={onDownloadCopy}>Download a copy</button>}
        <i />
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
      </div>
    </footer>
  );
}

function saveLabel(status: SaveStatus): string {
  if (status === 'saving') return 'Saving…';
  if (status === 'error') return 'Couldn’t save. Storage may be full.';
  return 'Saved on this device';
}
