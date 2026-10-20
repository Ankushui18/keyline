import { useEffect, useMemo, useState } from 'react';
import type { VectorDocument } from '../core/document';
import { analyzeConsistency, type ConsistencyReport } from '../core/consistency';
import { drawnObjectsForArtboard, realArtboards } from '../core/real-content';
import { exportDocumentToSvg } from '../export/svg-export';
import { isPixelGridVisible, setPixelGridVisible, subscribePixelGrid } from '../canvas/view-settings';
import { useSyncExternalStore } from 'react';

interface SetViewProps {
  document: VectorDocument;
  revision: number;
  fileName: string;
  styleSummary: string;
  onOpenIcon: (artboardId: string) => void;
  onFix: () => void;
  onShowObjects: (objectIds: string[]) => void;
  onExport: () => void;
  onShare: () => void;
  onBack: () => void;
}

const svgUrl = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** The icon set as one page: every icon frame at a glance, with the consistency check beside it. */
export function SetView({ document, revision, fileName, styleSummary, onOpenIcon, onFix, onShowObjects, onExport, onShare, onBack }: SetViewProps) {
  const [query, setQuery] = useState('');
  const gridOn = useSyncExternalStore(subscribePixelGrid, isPixelGridVisible);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement)) onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const { icons, report } = useMemo(() => {
    const report: ConsistencyReport = analyzeConsistency(document);
    const flagged = new Set(report.checks.flatMap((check) => check.objectIds));
    const icons = realArtboards(document)
      .filter((artboard) => drawnObjectsForArtboard(document, artboard.id).length > 0)
      .map((artboard) => {
        const objects = drawnObjectsForArtboard(document, artboard.id);
        let svg = '';
        try { svg = exportDocumentToSvg(document, { artboardId: artboard.id, exportBoundsMode: 'artboard', includeMetadata: false }); } catch { svg = ''; }
        return { id: artboard.id, name: artboard.name, size: Math.round(artboard.frame.width), svg, flagged: objects.some((object) => flagged.has(object.id)), objectIds: objects.map((object) => object.id) };
      });
    return { icons, report };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, revision]);

  const visible = icons.filter((icon) => icon.name.toLowerCase().includes(query.trim().toLowerCase()));
  const sizes = [...new Set(icons.map((icon) => icon.size))];
  const failing = report.checks.filter((check) => !check.passed);
  const fixCount = report.fixObjectIds.length;
  const flaggedIconCount = icons.filter((icon) => icon.flagged).length;

  return (
    <div className="setview" role="region" aria-label="Icon set">
      <div className="setview-main">
        <header className="setview-head">
          <button type="button" className="setview-back" onClick={onBack}>← Back to drawing</button>
          <strong>{fileName}</strong>
          <span>{icons.length} {icons.length === 1 ? 'icon' : 'icons'}{sizes.length === 1 ? ` · ${sizes[0]} px` : sizes.length > 1 ? ' · mixed sizes' : ''}</span>
          <span className="kd-spacer" />
          <button type="button" onClick={onShare}>Share</button>
          <button type="button" className="is-primary" onClick={onExport}>Export set</button>
        </header>
        <div className="setview-tools">
          <input type="search" placeholder="Search icons" aria-label="Search icons" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" aria-pressed={gridOn} className={gridOn ? 'is-active' : ''} onClick={() => setPixelGridVisible(!gridOn)}>Show grid</button>
        </div>
        {icons.length === 0
          ? <p className="setview-empty">No icons yet. Draw on an icon frame and it appears here.</p>
          : visible.length === 0
            ? <p className="setview-empty">No icon is called “{query}”.</p>
            : (
              <div className="setview-grid">
                {visible.map((icon) => (
                  <button type="button" key={icon.id} className={`setview-tile${icon.flagged ? ' is-flagged' : ''}`} title={icon.name} aria-label={`${icon.name}${icon.flagged ? ', needs a look' : ''}`} onClick={() => onOpenIcon(icon.id)}>
                    {icon.svg && <img alt="" src={svgUrl(icon.svg)} />}
                    {icon.flagged && <i aria-hidden="true" />}
                    <span>{icon.name}</span>
                  </button>
                ))}
              </div>
            )}
      </div>
      <aside className="setview-side" aria-label="Consistency check">
        <span className="setview-label">Consistency check</span>
        {report.objectCount === 0 ? <p className="setview-note">Nothing to check yet.</p> : (
          <>
            <div className="setview-checks">
              {report.checks.map((check) => (
                <div key={check.id} className="setview-check"><span>{check.label}</span><b className={check.passed ? 'is-pass' : 'is-warn'}>{check.status}</b></div>
              ))}
            </div>
            <div className="setview-actions">
              <button type="button" disabled={failing.length === 0} onClick={() => onShowObjects([...new Set(failing.flatMap((check) => check.objectIds))])}>Show them</button>
              <button type="button" className="is-primary" disabled={fixCount === 0} onClick={onFix}>{fixCount === 0 ? 'Nothing to fix' : `Fix ${flaggedIconCount || fixCount} ${(flaggedIconCount || fixCount) === 1 ? 'icon' : 'icons'}`}</button>
            </div>
            {fixCount > 0 && <p className="setview-note">Fixing sets the line width and ends to match the set. You can undo it in one step.</p>}
          </>
        )}
        <div className="setview-styles">
          <span className="setview-label">Set styles</span>
          <strong>{styleSummary}</strong>
          <small>New shapes start with these. Change them in Settings.</small>
        </div>
      </aside>
    </div>
  );
}
