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
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <div className="status-group">
        <span className="status-selection">{selectionLabel}</span>
        <span className="status-metrics"><strong>{nodeCount}</strong> nodes · <strong>{segmentCount}</strong> segments · <strong>{pathCount}</strong> paths · <strong>{regionCount}</strong> regions · <span className="constraint-status"><b className={`is-${solverStatus}`} /><strong>{constraintCount}</strong> constraints</span></span>
      </div>
      <div className="status-group status-right">
        <span className={`save-state is-${saveStatus}`}><b />{saveLabel(saveStatus)}</span>
        <i />
        <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
      </div>
    </footer>
  );
}

function saveLabel(status: SaveStatus): string {
  if (status === 'saving') return 'Saving…';
  if (status === 'error') return 'Save failed';
  return 'Saved on this device';
}
