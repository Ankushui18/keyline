import { contrastTextColor } from './contrast-color';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isPixelGridVisible, setPixelGridVisible, subscribePixelGrid } from '../canvas/view-settings';
import type { ConsistencyReport } from '../core/consistency';
import type { DrawingStyle } from '../core/types';
import { renderImportPreview } from '../import/import-preview';
import { applyTidy, type TidyAnalysis, type TidyRuleId } from '../import/tidy';
import type { SvgImportResult } from '../import/svg-import';
import { MODIFIER_LABEL } from './Toolbar';
import { useModalFocus } from './use-modal-focus';
import { palette } from '../design-system/tokens';

interface CommonDialogProps { onClose: () => void }

function useDialogEscape(onClose: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onClose]);
}

function Backdrop({ onClose, children, wide }: { onClose?: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  return (
    <div ref={ref} className={`modal-backdrop kd-backdrop${wide ? ' is-wide' : ''}`} onMouseDown={(event) => onClose && event.target === event.currentTarget && onClose()}>
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
  onCreateLink: () => Promise<boolean>;
  onCopyLink: () => Promise<boolean>;
  onStopSharing: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useDialogEscape(onClose);
  const statusText = status === 'synced' ? 'Live. Changes sync as you draw.'
    : status === 'offline' ? 'Offline. Changes sync when you reconnect.'
      : status === 'error' ? 'Could not reach the sharing server. Your work is still saved on this device.'
        : 'Connecting…';
  const sharing = Boolean(roomId);
  const initials = (name: string) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return (
    <Backdrop onClose={onClose}>
      <section className="kd-dialog kd-share" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header><h2 id="share-title">Share “{documentName}”</h2><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
        <div className="kd-people" aria-label="People in this drawing">
          <div><span className="kd-avatar" style={{ background: palette.blue700 }}>YO</span><span><strong>You</strong><small>This device</small></span><em>Can edit</em></div>
          {people.filter((person) => !/\(you\)$/i.test(person.name)).map((person) => (
            <div key={person.id}><span className="kd-avatar" style={{ background: person.color, color: contrastTextColor(person.color) }}>{initials(person.name)}</span><span><strong>{person.name}</strong><small className="is-good">{person.detail}</small></span><em>Can edit</em></div>
          ))}
          {sharing && people.filter((person) => !/\(you\)$/i.test(person.name)).length === 0 && <p className="kd-muted">No one else has joined yet. Send the link to start drawing together.</p>}
        </div>
        <div className="kd-linkrow">
          <span><strong>Anyone with the link</strong><small>{sharing ? 'Can edit with you. Turning off disconnects this device, not existing links.' : 'Not connected to a live room.'}</small></span>
          <Toggle label="Share a live link" value={sharing} onChange={(value) => { if (value) void onCreateLink().then(setCopied); else onStopSharing(); }} />
        </div>
        {sharing && <div className={`kd-status is-${status ?? 'connecting'}`} role="status"><i />{statusText}</div>}
        <div className="kd-copy">
          <code>{sharing ? link : 'Turn on the link to get an address to share'}</code>
          <button type="button" disabled={!sharing} onClick={() => { void onCopyLink().then(setCopied); }}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>
        <footer><button type="button" className="is-primary" onClick={onClose}>Done</button></footer>
      </section>
    </Backdrop>
  );
}

/* --------------------------------------------------------------- Settings */

export type SettingsSection = 'General' | 'Canvas and grid' | 'Performance' | 'Shortcuts' | 'AI and connections';
export const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  { title: 'Tools', items: [['Select', 'V'], ['Pen', 'P'], ['Pencil', 'N'], ['Brush', 'J'], ['Rectangle', 'R'], ['Rounded rectangle', '⇧ R'], ['Ellipse', 'U'], ['Polygon', 'G'], ['Star', 'S'], ['Line', '\\'], ['Arc', 'A'], ['Text', 'T']] },
  { title: 'Edit shape', items: [['Bend', 'D'], ['Cut', 'X or C'], ['Round corner', 'F'], ['Offset', 'O'], ['Stroke width', 'W'], ['Eraser', 'E'], ['Lasso', 'Q or L'], ['Shape builder', 'B'], ['Fill areas', '⇧ B']] },
  { title: 'Canvas', items: [['Pan', 'Scroll or Space + drag'], ['Zoom', `${MODIFIER_LABEL} + scroll`], ['Zoom in / out', `${MODIFIER_LABEL} + / -`], ['Nudge', 'Arrows or ⇧ + arrows']] },
  { title: 'Everywhere', items: [['Search or ask', `${MODIFIER_LABEL} K`], ['Motion', 'M'], ['Check icons', `${MODIFIER_LABEL} ⇧ C`], ['Constraints', 'K'], ['Undo', `${MODIFIER_LABEL} Z`], ['Redo', `${MODIFIER_LABEL} ⇧ Z`], ['Edit points', 'Enter'], ['Flip', '⇧ H or ⇧ V']] },
];

export function SettingsDialog({
  rendererMode,
  onRendererModeChange,
  reduceMotion,
  onReduceMotionChange,
  drawingStyle,
  onDrawingStyleChange,
  initialSection = 'General',
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
  const sections: SettingsSection[] = ['General', 'Canvas and grid', 'Performance', 'Shortcuts', 'AI and connections'];
  const gridOn = useSyncExternalStore(subscribePixelGrid, isPixelGridVisible);
  const subtitle: Record<SettingsSection, string> = { General: 'How new shapes look when you draw them.', 'Canvas and grid': 'What you see around your drawing.', Performance: 'Most people never need to change these.', Shortcuts: 'Every tool is one key away.', 'AI and connections': 'What Keyline connects to, and what it does not.' };
  return (
    <Backdrop onClose={onClose}>
      <section className="kd-dialog kd-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav aria-label="Settings sections">
          <strong id="settings-title">Settings</strong>
          {sections.map((item) => <button type="button" key={item} aria-current={section === item} className={section === item ? 'is-active' : ''} onClick={() => setSection(item)}>{item}</button>)}
        </nav>
        <div className="kd-settings-content">
          <header><div><h2>{section}</h2><p>{subtitle[section]}</p></div><button type="button" aria-label="Close" onClick={onClose}>×</button></header>
          {section === 'General' && (
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
          {section === 'Canvas and grid' && (
            <Row title="Pixel grid" description="Shows how icons land on the pixel grid when you zoom in.">
              <Toggle label="Pixel grid" value={gridOn} onChange={setPixelGridVisible} />
            </Row>
          )}
          {section === 'AI and connections' && (
            <>
              <Row title="Ask for an edit" description="Reads short phrases like “thinner” or “round ends”. Runs on this device. No AI model is used.">
                <span className="kd-tag">On this device</span>
              </Row>
              <Row title="AI model" description="No AI model is connected. Nothing you draw is sent anywhere.">
                <span className="kd-tag">Not connected</span>
              </Row>
              <Row title="Connect your own assistant" description="A way to let a tool you already use draw with you, with your approval for each change.">
                <span className="kd-tag">Planned</span>
              </Row>
            </>
          )}
          {section === 'Performance' && (
            <>
              <Row title="Drawing engine" description="GPU uses your graphics card. Try it on large drawings.">
                <Segmented value={rendererMode} options={[['canvas2d', 'Standard'], ['webgl', 'GPU']]} onChange={(value) => onRendererModeChange(value as 'canvas2d' | 'webgl')} label="Drawing engine" />
              </Row>
              <Row title="Reduce motion in the editor" description="Turns off panel and menu animation.">
                <Toggle label="Reduce motion in the editor" value={reduceMotion} onChange={onReduceMotionChange} />
              </Row>
              <div className="kd-sc-head"><span className="kd-label">Keyboard shortcuts</span><button type="button" onClick={() => setSection('Shortcuts')}>See all</button></div>
              <div className="kd-sc-grid">
                {[['Select', 'V'], ['Pen', 'P'], ['Edit shape', 'Enter'], ['Shapes', 'R · U'], ['Ask for an edit', `${MODIFIER_LABEL} K`], ['Motion', 'M']].map(([label, key]) => <div className="kd-shortcut" key={label}><span>{label}</span><kbd>{key}</kbd></div>)}
              </div>
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
            {imported.warnings?.length > 0 && (
              <p className="kd-note">
                {imported.warnings.length} unsupported {imported.warnings.length === 1 ? 'feature' : 'features'} will be dropped: {imported.warnings[0].message}
                {imported.warnings.length > 1 ? ` (+${imported.warnings.length - 1} more)` : ''}
              </p>
            )}
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

