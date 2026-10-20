import { useModalFocus } from './use-modal-focus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MOTION_EASINGS,
  MOTION_PRESETS,
  buildAnimatedSvg,
  clampMotionSettings,
  countAnimatedShapes,
  motionCss,
  motionTotalMs,
  motionTracks,
  type MotionPresetId,
  type MotionSettings,
} from '../export/motion-export';

const FPS = 60;
const kb = (text: string) => `${(new Blob([text]).size / 1024).toFixed(1)} KB`;
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const PRESET_ICONS: Record<MotionPresetId, JSX.Element> = {
  draw: <path d="M4 17c3-9 13-9 16 0" />,
  pulse: <><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /></>,
  swing: <path d="M12 3v8M12 11 7 20M12 11l5 9" />,
  pop: <path d="M5 7h14M5 12h10M5 17h6" />,
};

export interface MotionWorkspaceProps {
  fileName: string;
  /** Static SVG of the drawing, or undefined when there is nothing to animate. */
  svg: string | undefined;
  settings: MotionSettings;
  onSettingsChange: (settings: MotionSettings) => void;
  onDownload: () => void;
  onCopyCss: (css: string) => void;
  onClose: () => void;
}

export function MotionWorkspace({ fileName, svg, settings, onSettingsChange, onDownload, onCopyCss, onClose }: MotionWorkspaceProps) {
  const clean = clampMotionSettings(settings);
  const shapeCount = svg ? countAnimatedShapes(svg) : 0;
  const animated = useMemo(() => (svg ? buildAnimatedSvg(svg, clean) : undefined), [svg, clean.preset, clean.durationMs, clean.delayMs, clean.staggerMs, clean.easing, clean.loop]);
  const total = motionTotalMs(shapeCount, clean);
  const tracks = motionTracks(shapeCount, clean);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [exporting, setExporting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef, exporting);
  const [pair, setPair] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(0);
  const totalRef = useRef(total);
  totalRef.current = total;
  const loopRef = useRef(clean.loop);
  loopRef.current = clean.loop;

  const apply = useCallback((ms: number) => {
    stageRef.current?.querySelectorAll('svg').forEach((node) => {
      node.getAnimations({ subtree: true }).forEach((animation) => { animation.pause(); animation.currentTime = ms; });
    });
  }, []);

  // One clock drives the preview and the timeline so they never disagree.
  useEffect(() => {
    if (!playing) { apply(timeRef.current); return; }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      let next = timeRef.current + (now - last);
      last = now;
      if (next >= totalRef.current) {
        if (loopRef.current) next = 0; else { next = totalRef.current; setPlaying(false); }
      }
      timeRef.current = next;
      setTime(next);
      apply(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, apply, animated]);

  useEffect(() => { timeRef.current = 0; setTime(0); setPlaying(true); }, [animated]);
  useEffect(() => { apply(timeRef.current); });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (exporting) setExporting(false); else onClose(); }
      if (event.key === ' ' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement)) {
        event.preventDefault(); setPlaying((value) => !value);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [exporting, onClose]);

  const update = (updates: Partial<MotionSettings>) => onSettingsChange({ ...settings, ...updates });
  const seek = (ms: number) => { const value = Math.max(0, Math.min(total, ms)); timeRef.current = value; setTime(value); setPlaying(false); apply(value); };
  const frameNumber = Math.min(Math.round(total / 1000 * FPS), Math.round(time / 1000 * FPS) + 1);
  const frameCount = Math.max(1, Math.round(total / 1000 * FPS));
  const presetName = MOTION_PRESETS.find((preset) => preset.id === clean.preset)?.name ?? '';
  const inline = (size: number | string, key: string) => (
    <div key={key} className="mw-art" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: (animated ?? '').replace(/<svg\b([^>]*)>/, (_m, attrs: string) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="100%" height="100%">`) }} />
  );

  if (exporting) {
    return (
      <div ref={modalRef} className="mw-export-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setExporting(false)}>
        <section className="mw-export" role="dialog" aria-modal="true" aria-labelledby="mw-export-title">
          <header><h2 id="mw-export-title">Export motion</h2><span>{fileName} · {(total / 1000).toFixed(1)}s{clean.loop ? ' · loops' : ''}</span></header>
          <ExportChoices svg={animated} css={motionCss(clean)} onDownload={() => { onDownload(); setExporting(false); }} onCopyCss={(css) => { onCopyCss(css); setExporting(false); }} onCancel={() => setExporting(false)} />
        </section>
      </div>
    );
  }

  return (
    <div ref={modalRef} className="mw" role="dialog" aria-modal="true" aria-labelledby="mw-title">
      <header className="mw-top">
        <div className="mw-brand"><svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#26272b" /><rect x="14" y="14" width="36" height="36" fill="none" stroke="#ececee" strokeWidth="3.5" /><circle cx="32" cy="32" r="18" fill="none" stroke="#ececee" strokeWidth="3.5" /><rect x="44" y="8" width="12" height="12" fill="#0d99ff" /></svg><strong id="mw-title">{fileName}</strong></div>
        <div className="mw-mode" role="group" aria-label="Mode"><button type="button" onClick={onClose}>Design</button><button type="button" aria-pressed="true" className="is-active">Motion</button></div>
        <span className="mw-grow" />
        <button type="button" className="mw-ghost" aria-pressed={pair} onClick={() => setPair((value) => !value)}>Check at 16 and 24 px</button>
        <button type="button" className="mw-primary" disabled={!animated || animated === svg} onClick={() => setExporting(true)}>Export motion</button>
      </header>

      <div className="mw-body">
        <aside className="mw-left" aria-label="Presets">
          <span className="mw-label">Start with a preset</span>
          {MOTION_PRESETS.map((preset) => (
            <button type="button" key={preset.id} className={`mw-preset${clean.preset === preset.id ? ' is-active' : ''}`} aria-pressed={clean.preset === preset.id} onClick={() => update({ preset: preset.id })}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">{PRESET_ICONS[preset.id]}</svg>
              <span><strong>{preset.name}</strong><small>{preset.description}</small></span>
            </button>
          ))}
          <p className="mw-help">Presets only move parts you already have. Nothing is baked in, so you can still edit the drawing after.</p>
        </aside>

        <div className="mw-stage" ref={stageRef}>
          {animated && animated !== svg ? (
            <>
              <span className="mw-frame">{(time / 1000).toFixed(2)}s · frame {frameNumber} of {frameCount}</span>
              {pair ? <div className="mw-pair">{inline(16, 'a')}{inline(24, 'b')}</div> : inline('min(60%, 380px)', 'big')}
              <div className="mw-sizes" aria-label="Small previews">{inline(16, 's16')}<small>16</small>{inline(24, 's24')}<small>24</small></div>
            </>
          ) : <p className="mw-empty">Draw something on an icon frame, then animate it here.</p>}
        </div>

        <aside className="mw-right" aria-label="Timing">
          <span className="mw-label">{presetName} · Timing</span>
          <NumberField label="Duration" unit="ms" value={settings.durationMs} min={100} max={10000} step={50} onChange={(value) => update({ durationMs: value })} />
          <NumberField label="Delay" unit="ms" value={settings.delayMs} min={0} max={5000} step={50} onChange={(value) => update({ delayMs: value })} />
          <NumberField label="Between parts" unit="ms" value={settings.staggerMs} min={0} max={1000} step={10} onChange={(value) => update({ staggerMs: value })} />
          <label className="mw-field"><span>Feel</span>
            <select aria-label="Feel" value={settings.easing} onChange={(event) => update({ easing: event.target.value as MotionSettings['easing'] })}>{MOTION_EASINGS.map((easing) => <option key={easing.id} value={easing.id}>{easing.name}</option>)}</select>
          </label>
          <label className="mw-field"><span>Repeat</span>
            <select aria-label="Repeat" value={settings.loop ? 'loop' : 'once'} onChange={(event) => update({ loop: event.target.value === 'loop' })}><option value="once">Once</option><option value="loop">Loop</option></select>
          </label>
          <p className="mw-next">Animating a number and morphing between variants are next. Today, presets move the parts of your drawing.</p>
        </aside>
      </div>

      <section className="mw-timeline" aria-label="Timeline">
        <div className="mw-controls">
          <button type="button" className="mw-play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (!playing && time >= total) { timeRef.current = 0; setTime(0); } setPlaying((value) => !value); }}>
            {playing ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg> : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z" /></svg>}
          </button>
          <span className="mw-time">{(time / 1000).toFixed(2)} / {(total / 1000).toFixed(2)}s</span><small>{FPS} fps</small>
          <span className="mw-grow" />
          <label className="mw-switch"><span>Loop</span><button type="button" role="switch" aria-checked={clean.loop} aria-label="Loop" className={clean.loop ? 'is-on' : ''} onClick={() => update({ loop: !clean.loop })}><i /></button></label>
          <label className="mw-switch"><span>Respect “reduce motion”</span><button type="button" role="switch" aria-checked="true" aria-label="Respect reduce motion (always on)" className="is-on" disabled><i /></button></label>
        </div>
        <div className="mw-grid">
          <div className="mw-names">
            <div className="mw-ruler-gap" />
            {tracks.length === 0 && <span className="mw-empty-row">No parts to animate yet</span>}
            {tracks.map((track) => <span key={track.label}>{track.label}</span>)}
          </div>
          <div className="mw-lanes">
            <input className="mw-scrub" type="range" min={0} max={Math.max(1, total)} step={1} value={Math.round(time)} aria-label="Scrub the animation" onChange={(event) => seek(Number(event.target.value))} />
            <div className="mw-ruler" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map((part) => <span key={part}>{((total * part) / 1000).toFixed(2).replace(/\.?0+$/, '') || '0'}</span>)}</div>
            {tracks.map((track) => (
              <div className="mw-lane" key={track.label}><span style={{ left: `${(track.startMs / total) * 100}%`, width: `${((track.endMs - track.startMs) / total) * 100}%` }} /></div>
            ))}
            <i className="mw-playhead" style={{ left: `${total > 0 ? (time / total) * 100 : 0}%` }} aria-hidden="true" />
          </div>
        </div>
      </section>
    </div>
  );
}

function NumberField({ label, unit, value, min, max, step, onChange }: { label: string; unit: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="mw-field"><span>{label}</span>
      <span className="mw-num"><input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /><em>{unit}</em></span>
    </label>
  );
}

function ExportChoices({ svg, css, onDownload, onCopyCss, onCancel }: { svg: string | undefined; css: string; onDownload: () => void; onCopyCss: (css: string) => void; onCancel: () => void }) {
  const [choice, setChoice] = useState<'svg' | 'css'>('svg');
  const rows: Array<{ id: 'svg' | 'css' | 'react' | 'lottie' | 'video'; title: string; text: string; badge?: string; size?: string }> = [
    { id: 'svg', title: 'Animated SVG', text: 'One file, plays anywhere an image does', size: svg ? kb(svg) : undefined },
    { id: 'css', title: 'CSS animation', text: 'Keyframes you paste into your own site', size: kb(css) },
    { id: 'react', title: 'React component', text: 'Props for play, pause and speed', badge: 'Next' },
    { id: 'lottie', title: 'Lottie JSON', text: 'For apps that already play Lottie', badge: 'Later' },
    { id: 'video', title: 'GIF or video', text: 'For slides and social posts', badge: 'Later' },
  ];
  return (
    <>
      <div className="mw-choices" role="radiogroup" aria-label="Format">
        {rows.map((row) => (
          <button type="button" key={row.id} role="radio" aria-checked={choice === row.id} disabled={Boolean(row.badge)} className={`mw-choice${choice === row.id ? ' is-active' : ''}`} onClick={() => row.id === 'svg' || row.id === 'css' ? setChoice(row.id) : undefined}>
            <i aria-hidden="true" />
            <span><strong>{row.title}</strong><small>{row.text}</small></span>
            {row.badge ? <em>{row.badge}</em> : <b>{row.size}</b>}
          </button>
        ))}
      </div>
      <p className="mw-reduced"><span>Plays on a page with “reduce motion” on? Shows the final frame.</span><b>Included</b></p>
      <footer><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="mw-primary" onClick={() => (choice === 'svg' ? onDownload() : onCopyCss(css))}>{choice === 'svg' ? 'Download SVG' : 'Copy CSS'}</button></footer>
    </>
  );
}

export { svgUrl };
