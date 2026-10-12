import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ConsistencyReport } from '../core/consistency';
import type { DrawingStyle } from '../core/types';
import { renderImportPreview } from '../import/import-preview';
import { applyTidy, type TidyAnalysis, type TidyRuleId } from '../import/tidy';
import type { SvgImportResult } from '../import/svg-import';
import {
  MOTION_EASINGS,
  MOTION_PRESETS,
  buildAnimatedSvg,
  clampMotionSettings,
  countAnimatedShapes,
  motionCss,
  motionTotalMs,
  motionTracks,
  type MotionSettings,
} from '../export/motion-export';
import { MODIFIER_LABEL } from './Toolbar';

interface CommonDialogProps { onClose: () => void }

function useDialogEscape(onClose: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose]);
}

function Backdrop({ onClose, children, wide }: { onClose?: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`modal-backdrop kd-backdrop${wide ? ' is-wide' : ''}`} onMouseDown={(event) => onClose && event.target === event.currentTarget && onClose()}>
      {children}
    </div>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} className={`kd-toggle ${value ? 'is-on' : ''}`} onClick={() => onChange(!value)}><i /></button>;
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/* ------------------------------------------------------------------ Share */

export interface SharePerson { id: string; name: string; color: string; detail: string }

export function ShareDialog({
  documentName,
  roomId,
  link,
  status,
  people,
  onCreateLink,
  onCopyLink,
  onStopSharing,
  onClose,
}: CommonDialogProps & {
  documentName: string;
  roomId: string | null;
  link: string;
  status: 'connecting' | 'synced' | 'offline' | 'error' | null;
  people: SharePerson[];
  onCreateLink: () => void;
  onCopyLink: () => void;
  onStopSharing: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useDialogEscape(onClose);
  const statusText = status === 'synced' ? 'Live. Changes sync as you draw.'
    : status === 'offline' ? 'Offline. Changes sync when you reconnect.'
      : status === 'error' ? 'Could not reach the sharing server. Your work is still saved on this device.'
        : 'Connecting…';
  return (
    <Backdrop onClose={onClose}>
      <section className="kd-dialog kd-share" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header><h2 id="share-title">Share “{documentName}”</h2><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
        {!roomId ? (
          <>
            <p className="kd-lead">Make a live link. Anyone who opens it edits this drawing with you, and you see each other’s cursors.</p>
            <ul className="kd-bullets">
              <li>The drawing stays on this device until someone opens the link.</li>
              <li>Anyone with the link can edit. Stop sharing at any time.</li>
            </ul>
            <footer><button type="button" onClick={onClose}>Not now</button><button type="button" className="is-primary" onClick={() => { onCreateLink(); setCopied(true); }}>Create link and copy</button></footer>
          </>
        ) : (
          <>
            <div className={`kd-status is-${status ?? 'connecting'}`} role="status"><i />{statusText}</div>
            <div className="kd-copy">
              <code>{link}</code>
              <button type="button" onClick={() => { onCopyLink(); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy link'}</button>
            </div>
            <div className="kd-people" aria-label="People in this drawing">
              {people.map((person) => (
                <div key={person.id}><span className="kd-avatar" style={{ background: person.color }}>{person.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><span><strong>{person.name}</strong><small>{person.detail}</small></span></div>
              ))}
              {people.length <= 1 && <p className="kd-muted">No one else has joined yet. Send the link to start drawing together.</p>}
            </div>
            <footer><button type="button" className="is-danger" onClick={onStopSharing}>Stop sharing</button><button type="button" className="is-primary" onClick={onClose}>Done</button></footer>
          </>
        )}
      </section>
    </Backdrop>
  );
}

/* --------------------------------------------------------------- Settings */

export type SettingsSection = 'Drawing' | 'Performance' | 'Shortcuts';
export const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  { title: 'Tools', items: [['Select', 'V'], ['Pen', 'P'], ['Pencil', 'N'], ['Brush', 'J'], ['Rectangle', 'R'], ['Rounded rectangle', '⇧ R'], ['Ellipse', 'U'], ['Polygon', 'G'], ['Star', 'S'], ['Line', '\\'], ['Arc', 'A']] },
  { title: 'Edit shape', items: [['Bend', 'D'], ['Cut', 'X or C'], ['Round corner', 'F'], ['Offset', 'O'], ['Stroke width', 'W'], ['Eraser', 'E'], ['Lasso', 'Q or L'], ['Shape builder', 'B'], ['Fill areas', '⇧ B']] },
  { title: 'Everywhere', items: [['Search or ask', `${MODIFIER_LABEL} K`], ['Motion', 'M'], ['Check icons', `${MODIFIER_LABEL} ⇧ C`], ['Constraints', 'K'], ['Undo', `${MODIFIER_LABEL} Z`], ['Redo', `${MODIFIER_LABEL} ⇧ Z`], ['Edit points', 'Enter'], ['Flip', '⇧ H or ⇧ V']] },
];

export function SettingsDialog({
  rendererMode,
  onRendererModeChange,
  reduceMotion,
  onReduceMotionChange,
  drawingStyle,
  onDrawingStyleChange,
  initialSection = 'Drawing',
  onClose,
}: CommonDialogProps & {
  rendererMode: 'canvas2d' | 'webgl';
  onRendererModeChange: (mode: 'canvas2d' | 'webgl') => void;
  reduceMotion: boolean;
  onReduceMotionChange: (value: boolean) => void;
  drawingStyle: DrawingStyle;
  onDrawingStyleChange: (updates: Partial<DrawingStyle>) => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [widthText, setWidthText] = useState(String(drawingStyle.strokeWidth));
  useDialogEscape(onClose);
  const sections: SettingsSection[] = ['Drawing', 'Performance', 'Shortcuts'];
  return (
    <Backdrop onClose={onClose}>
      <section className="kd-dialog kd-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav aria-label="Settings sections">
          <strong id="settings-title">Settings</strong>
          {sections.map((item) => <button type="button" key={item} aria-current={section === item} className={section === item ? 'is-active' : ''} onClick={() => setSection(item)}>{item}</button>)}
        </nav>
        <div className="kd-settings-content">
          <header><div><h2>{section}</h2><p>{section === 'Drawing' ? 'How new shapes look when you draw them.' : section === 'Performance' ? 'Most people never need to change these.' : 'Every tool is one key away.'}</p></div><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
          {section === 'Drawing' && (
            <>
              <Row title="Line width" description="New shapes start with this width, in pixels.">
                <input className="kd-number" type="number" min="0.25" max="64" step="0.25" aria-label="Default line width" value={widthText}
                  onChange={(event) => { setWidthText(event.target.value); const value = Number(event.target.value); if (value > 0) onDrawingStyleChange({ strokeWidth: value }); }} />
              </Row>
              <Row title="Line ends" description="Round ends look softer. Flat ends are exact.">
                <Segmented value={drawingStyle.strokeCap} options={[['round', 'Round'], ['butt', 'Flat'], ['square', 'Square']]} onChange={(value) => onDrawingStyleChange({ strokeCap: value as DrawingStyle['strokeCap'] })} label="Line ends" />
              </Row>
              <Row title="Corners" description="How two lines meet.">
                <Segmented value={drawingStyle.strokeJoin} options={[['round', 'Round'], ['miter', 'Sharp'], ['bevel', 'Bevel']]} onChange={(value) => onDrawingStyleChange({ strokeJoin: value as DrawingStyle['strokeJoin'] })} label="Corners" />
              </Row>
              <Row title="Fill new shapes" description="Off is best for line icons.">
                <Toggle label="Fill new shapes" value={drawingStyle.fillEnabled} onChange={(value) => onDrawingStyleChange({ fillEnabled: value })} />
              </Row>
            </>
          )}
          {section === 'Performance' && (
            <>
              <Row title="Drawing engine" description="Accelerated uses your graphics card. Try it on large drawings.">
                <Segmented value={rendererMode} options={[['canvas2d', 'Standard'], ['webgl', 'Accelerated']]} onChange={(value) => onRendererModeChange(value as 'canvas2d' | 'webgl')} label="Drawing engine" />
              </Row>
              <Row title="Reduce motion in the editor" description="Turns off panel and menu animation.">
                <Toggle label="Reduce motion in the editor" value={reduceMotion} onChange={onReduceMotionChange} />
              </Row>
            </>
          )}
          {section === 'Shortcuts' && (
            <div className="kd-shortcuts">
              {SHORTCUT_GROUPS.map((group) => (
                <div key={group.title}><h3>{group.title}</h3>{group.items.map(([label, key]) => <div className="kd-shortcut" key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div>
              ))}
            </div>
          )}
          <footer><button type="button" className="is-primary" onClick={onClose}>Done</button></footer>
        </div>
      </section>
    </Backdrop>
  );
}

function Row({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="kd-row"><span><strong>{title}</strong><small>{description}</small></span>{children}</div>;
}
function Segmented({ value, options, onChange, label }: { value: string; options: Array<[string, string]>; onChange: (value: string) => void; label: string }) {
  return <div className="kd-segmented" role="group" aria-label={label}>{options.map(([id, text]) => <button type="button" key={id} aria-pressed={value === id} className={value === id ? 'is-active' : ''} onClick={() => onChange(id)}>{text}</button>)}</div>;
}

/* ------------------------------------------------------------ Import tidy */

export function ImportTidyDialog({
  filename,
  imported,
  analysis,
  onCancel,
  onOpenAsIs,
  onApply,
}: {
  filename: string;
  imported: SvgImportResult;
  analysis: TidyAnalysis;
  onCancel: () => void;
  onOpenAsIs: () => void;
  onApply: (rules: Set<TidyRuleId>) => void;
}) {
  const [enabled, setEnabled] = useState(() => new Set(analysis.rules.filter((rule) => rule.defaultOn).map((rule) => rule.id)));
  useDialogEscape(onCancel);
  const before = useMemo(() => renderImportPreview(imported.payload, imported.viewport), [imported]);
  const tidied = useMemo(() => applyTidy(imported.payload, imported.viewport, enabled), [enabled, imported]);
  const after = useMemo(() => renderImportPreview(tidied, imported.viewport), [tidied, imported]);
  const pointsAfter = tidied.objects.reduce((sum, item) => sum + item.nodes.length, 0);
  const toggle = (id: TidyRuleId) => setEnabled((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <Backdrop onClose={onCancel}>
      <section className="kd-dialog kd-tidy" role="dialog" aria-modal="true" aria-labelledby="tidy-title">
        <header><h2 id="tidy-title">Tidy this SVG before you start</h2><span>{filename}</span></header>
        <div className="kd-tidy-main">
          <div className="kd-tidy-previews">
            <figure><div>{before ? <img alt="Before tidying" src={svgUrl(before)} /> : null}</div><figcaption>Before · {analysis.pointCount} points</figcaption></figure>
            <figure><div>{after ? <img alt="After tidying" src={svgUrl(after)} /> : null}</div><figcaption className={pointsAfter < analysis.pointCount ? 'is-good' : ''}>After · {pointsAfter} points</figcaption></figure>
          </div>
          <div className="kd-tidy-rules" role="group" aria-label="Suggested fixes">
            <strong className="kd-label">What we found</strong>
            {analysis.rules.map((rule) => (
              <button type="button" role="checkbox" aria-checked={enabled.has(rule.id)} key={rule.id} className="kd-rule" onClick={() => toggle(rule.id)}>
                <i className={enabled.has(rule.id) ? 'is-checked' : ''} aria-hidden="true">{enabled.has(rule.id) ? '✓' : ''}</i>
                <span><strong>{rule.title}</strong><small>{rule.description}</small></span>
              </button>
            ))}
          </div>
        </div>
        <footer>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={onOpenAsIs}>Open as is</button>
          <button type="button" className="is-primary" onClick={() => onApply(enabled)}>{enabled.size === 0 ? 'Open' : `Tidy and open`}</button>
        </footer>
      </section>
    </Backdrop>
  );
}

/* ----------------------------------------------------------------- Motion */

export function MotionDialog({
  objectName,
  svg,
  settings,
  onSettingsChange,
  onDownload,
  onCopyCss,
  onClose,
}: CommonDialogProps & {
  objectName: string;
  /** Static SVG of the active artboard, or undefined when there is nothing to animate. */
  svg: string | undefined;
  settings: MotionSettings;
  onSettingsChange: (settings: MotionSettings) => void;
  onDownload: () => void;
  onCopyCss: (css: string) => void;
  onClose: () => void;
}) {
  const [previewSize, setPreviewSize] = useState<16 | 24 | 320>(320);
  const [playKey, setPlayKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const clean = clampMotionSettings(settings);
  const shapeCount = svg ? countAnimatedShapes(svg) : 0;
  const animated = useMemo(() => svg ? buildAnimatedSvg(svg, clean) : undefined, [svg, clean.preset, clean.durationMs, clean.delayMs, clean.staggerMs, clean.easing, clean.loop]);
  const tracks = motionTracks(shapeCount, clean);
  const total = motionTotalMs(shapeCount, clean);
  useDialogEscape(exporting ? () => setExporting(false) : onClose);
  const update = (updates: Partial<MotionSettings>) => { onSettingsChange({ ...settings, ...updates }); setPlayKey((key) => key + 1); };

  if (exporting) {
    return (
      <Backdrop onClose={() => setExporting(false)}>
        <section className="kd-dialog kd-motion-export" role="dialog" aria-modal="true" aria-labelledby="motion-export-title">
          <header><div><h2 id="motion-export-title">Export motion</h2><span>{objectName} · {(total / 1000).toFixed(1)}s{clean.loop ? ' · loops' : ''}</span></div><button type="button" aria-label="Close" onClick={() => setExporting(false)}>×</button></header>
          <div className="kd-formats">
            <button type="button" className="is-active" onClick={() => { onDownload(); setExporting(false); }}><span><strong>Animated SVG</strong><small>One file that plays anywhere an image does</small></span><b>Download</b></button>
            <button type="button" onClick={() => { onCopyCss(motionCss(clean)); setExporting(false); }}><span><strong>CSS animation</strong><small>Keyframes to paste into your own styles</small></span><b>Copy</b></button>
            <button type="button" disabled><span><strong>React component</strong><small>Props for play, pause and speed</small></span><b>Later</b></button>
            <button type="button" disabled><span><strong>Lottie JSON</strong><small>For apps that already play Lottie</small></span><b>Later</b></button>
            <button type="button" disabled><span><strong>GIF or video</strong><small>For slides and social posts</small></span><b>Later</b></button>
          </div>
          <p className="kd-note">Visitors who turn on “reduce motion” see the finished drawing instead of the animation. This is built in.</p>
          <footer><button type="button" onClick={() => setExporting(false)}>Back</button></footer>
        </section>
      </Backdrop>
    );
  }

  return (
    <Backdrop wide>
      <section className="kd-dialog kd-motion" role="dialog" aria-modal="true" aria-labelledby="motion-title">
        <header>
          <div><strong id="motion-title">{objectName}</strong><span>Motion</span></div>
          <div className="kd-header-actions">
            <button type="button" className="is-primary" disabled={!animated || animated === svg} onClick={() => setExporting(true)}>Export motion</button>
            <button type="button" aria-label="Close motion" onClick={onClose}>×</button>
          </div>
        </header>
        <div className="kd-motion-body">
          <aside aria-label="Presets">
            <span className="kd-label">Start with a preset</span>
            {MOTION_PRESETS.map((preset) => (
              <button type="button" key={preset.id} aria-pressed={settings.preset === preset.id} className={`kd-preset${settings.preset === preset.id ? ' is-active' : ''}`} onClick={() => update({ preset: preset.id })}>
                <strong>{preset.name}</strong><small>{preset.description}</small>
              </button>
            ))}
            <p className="kd-muted">Motion is added when you export. Your drawing is not changed.</p>
          </aside>
          <div className="kd-motion-stage">
            {animated && animated !== svg ? (
              <img key={`${playKey}-${previewSize}`} alt={`${objectName} animated with ${MOTION_PRESETS.find((p) => p.id === settings.preset)?.name}`} src={svgUrl(animated)} width={previewSize} height={previewSize} />
            ) : (
              <p className="kd-muted">Draw something on an icon frame, then animate it here.</p>
            )}
            <footer>
              {([16, 24, 320] as const).map((size) => <button type="button" key={size} aria-pressed={previewSize === size} className={previewSize === size ? 'is-active' : ''} onClick={() => setPreviewSize(size)}>{size === 320 ? 'Large' : `${size} px`}</button>)}
              <button type="button" onClick={() => setPlayKey((key) => key + 1)}>↻ Replay</button>
            </footer>
          </div>
          <aside aria-label="Timing">
            <span className="kd-label">Timing</span>
            <NumberRow label="Duration" unit="ms" value={settings.durationMs} min={100} max={10000} step={50} onChange={(value) => update({ durationMs: value })} />
            <NumberRow label="Delay" unit="ms" value={settings.delayMs} min={0} max={5000} step={50} onChange={(value) => update({ delayMs: value })} />
            <NumberRow label="Between shapes" unit="ms" value={settings.staggerMs} min={0} max={1000} step={10} onChange={(value) => update({ staggerMs: value })} />
            <div className="kd-row"><span><strong>Feel</strong></span>
              <select aria-label="Feel" value={settings.easing} onChange={(event) => update({ easing: event.target.value as MotionSettings['easing'] })}>{MOTION_EASINGS.map((easing) => <option key={easing.id} value={easing.id}>{easing.name}</option>)}</select>
            </div>
            <div className="kd-row"><span><strong>Loop</strong></span><Toggle label="Loop" value={settings.loop} onChange={(value) => update({ loop: value })} /></div>
          </aside>
        </div>
        <section className="kd-timeline" aria-label="Timeline">
          <div className="kd-timeline-ruler" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map((part) => <span key={part}>{((total * part) / 1000).toFixed(2).replace(/\.?0+$/, '') || '0'}s</span>)}</div>
          {tracks.length === 0 && <p className="kd-muted">No shapes to animate yet.</p>}
          {tracks.map((track) => (
            <div className="kd-track" key={track.label}>
              <strong>{track.label}</strong>
              <div><span style={{ left: `${(track.startMs / total) * 100}%`, width: `${((track.endMs - track.startMs) / total) * 100}%` }} /></div>
            </div>
          ))}
        </section>
      </section>
    </Backdrop>
  );
}

function NumberRow({ label, unit, value, min, max, step, onChange }: { label: string; unit: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="kd-row"><span><strong>{label}</strong></span>
      <span className="kd-number-wrap"><input className="kd-number" type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /><em>{unit}</em></span>
    </label>
  );
}

/* ----------------------------------------------------------------- Check */

export function ConsistencyDialog({
  report,
  fileName,
  onFix,
  onShow,
  onOpenAdvanced,
  onClose,
}: CommonDialogProps & {
  report: ConsistencyReport;
  fileName: string;
  onFix: () => void;
  onShow: (objectIds: string[]) => void;
  onOpenAdvanced: () => void;
}) {
  useDialogEscape(onClose);
  const failing = report.checks.filter((check) => !check.passed);
  const fixCount = report.fixObjectIds.length;
  return (
    <Backdrop onClose={onClose}>
      <section className="kd-dialog kd-check" role="dialog" aria-modal="true" aria-labelledby="check-title">
        <header><div><h2 id="check-title">Check “{fileName}”</h2><span>{report.iconCount} {report.iconCount === 1 ? 'icon' : 'icons'} · {report.objectCount} {report.objectCount === 1 ? 'shape' : 'shapes'}</span></div><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
        {report.objectCount === 0 ? <p className="kd-lead">Nothing to check yet. Draw a few shapes on an icon frame and come back.</p> : (
          <>
            <p className={`kd-lead ${failing.length === 0 ? 'is-good' : ''}`}>{failing.length === 0 ? 'Everything is consistent.' : `${failing.length} ${failing.length === 1 ? 'thing needs' : 'things need'} a look.`}</p>
            <div className="kd-checks">
              {report.checks.map((check) => (
                <div key={check.id} className="kd-check-row">
                  <span>{check.label}</span>
                  <b className={check.passed ? 'is-pass' : 'is-warn'}>{check.status}</b>
                  {!check.passed && <button type="button" onClick={() => onShow(check.objectIds)}>Show</button>}
                </div>
              ))}
            </div>
            {report.target && fixCount > 0 && <p className="kd-note">Fixing sets {fixCount} {fixCount === 1 ? 'shape' : 'shapes'} to {report.target.strokeWidth} px lines with {report.target.cap} ends and {report.target.join} corners, the most common style in this file. You can undo it in one step.</p>}
          </>
        )}
        <footer>
          <button type="button" onClick={onOpenAdvanced}>Icon families</button>
          <span className="kd-spacer" />
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" className="is-primary" disabled={fixCount === 0} onClick={onFix}>{fixCount === 0 ? 'Nothing to fix' : `Fix ${fixCount} ${fixCount === 1 ? 'shape' : 'shapes'}`}</button>
        </footer>
      </section>
    </Backdrop>
  );
}

