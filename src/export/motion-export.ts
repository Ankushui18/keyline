/**
 * Turns an exported static SVG into an animated SVG using only CSS keyframes.
 * Nothing here changes the drawing: motion is applied to a copy at export time.
 */

export type MotionPresetId = 'draw' | 'pulse' | 'swing' | 'pop';
export type MotionEasing = 'ease-out' | 'ease-in-out' | 'linear' | 'spring';

export interface MotionPreset {
  id: MotionPresetId;
  name: string;
  description: string;
}

export const MOTION_PRESETS: MotionPreset[] = [
  { id: 'draw', name: 'Draw on', description: 'Lines trace themselves' },
  { id: 'pulse', name: 'Pulse', description: 'Grow and settle' },
  { id: 'swing', name: 'Swing', description: 'Rotate from the top' },
  { id: 'pop', name: 'Pop in', description: 'Parts appear one by one' },
];

export const MOTION_EASINGS: Array<{ id: MotionEasing; name: string; css: string }> = [
  { id: 'ease-out', name: 'Ease out', css: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  { id: 'ease-in-out', name: 'Ease in and out', css: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  { id: 'linear', name: 'Even', css: 'linear' },
  { id: 'spring', name: 'Springy', css: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
];

export interface MotionSettings {
  preset: MotionPresetId;
  durationMs: number;
  delayMs: number;
  staggerMs: number;
  easing: MotionEasing;
  loop: boolean;
}

export const DEFAULT_MOTION_SETTINGS: MotionSettings = {
  preset: 'draw',
  durationMs: 800,
  delayMs: 0,
  staggerMs: 80,
  easing: 'ease-out',
  loop: true,
};

export function clampMotionSettings(settings: MotionSettings): MotionSettings {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? Math.round(value) : min));
  return {
    ...settings,
    durationMs: clamp(settings.durationMs, 100, 10_000),
    delayMs: clamp(settings.delayMs, 0, 5_000),
    staggerMs: clamp(settings.staggerMs, 0, 1_000),
  };
}

const KEYFRAMES: Record<MotionPresetId, string> = {
  draw: '@keyframes kl-draw{0%{stroke-dashoffset:1}60%,100%{stroke-dashoffset:0}}@keyframes kl-fill{0%,50%{opacity:0}100%{opacity:1}}',
  pulse: '@keyframes kl-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}',
  swing: '@keyframes kl-swing{0%,100%{transform:rotate(0)}25%{transform:rotate(10deg)}75%{transform:rotate(-10deg)}}',
  pop: '@keyframes kl-pop{0%{opacity:0;transform:scale(.6)}60%{opacity:1}100%{opacity:1;transform:scale(1)}}',
};

export function motionCss(input: MotionSettings): string {
  const settings = clampMotionSettings(input);
  const easing = MOTION_EASINGS.find((item) => item.id === settings.easing)?.css ?? 'linear';
  const iterations = settings.loop ? 'infinite' : '1';
  const base = `.kl{animation-duration:${settings.durationMs}ms;animation-delay:calc(${settings.delayMs}ms + var(--i,0) * ${settings.staggerMs}ms);animation-timing-function:${easing};animation-iteration-count:${iterations};animation-fill-mode:both;transform-box:fill-box;transform-origin:center}`;
  const preset: Record<MotionPresetId, string> = {
    draw: '.kl-line{stroke-dasharray:1;stroke-dashoffset:1;animation-name:kl-draw}.kl-fill{animation-name:kl-fill}',
    pulse: '.kl{animation-name:kl-pulse}',
    swing: '.kl{animation-name:kl-swing;transform-origin:50% 0}',
    pop: '.kl{animation-name:kl-pop}',
  };
  const reduced = '@media (prefers-reduced-motion:reduce){.kl{animation:none!important;stroke-dashoffset:0!important;opacity:1!important;transform:none!important}}';
  return `${KEYFRAMES[settings.preset]}${base}${preset[settings.preset]}${reduced}`;
}

/** Number of drawable shapes in an exported SVG string. */
export function countAnimatedShapes(svg: string): number {
  return (svg.match(/<path\b/g) ?? []).length;
}

/** Adds animation classes to every path and injects the style block. Returns the original SVG if there is nothing to animate. */
export function buildAnimatedSvg(svg: string, settings: MotionSettings): string {
  if (countAnimatedShapes(svg) === 0) return svg;
  let index = 0;
  const withClasses = svg.replace(/<path\b([^>]*?)(\/?)>/g, (_match, attributes: string, close: string) => {
    const isFill = !/\bfill="none"/.test(attributes);
    const kind = isFill ? 'kl kl-fill' : 'kl kl-line';
    const attrs = attributes.replace(/\s+pathLength="[^"]*"/, '');
    const position = index;
    index += 1;
    return `<path class="${kind}" style="--i:${position}" pathLength="1"${attrs}${close}>`;
  });
  return withClasses.replace(/(<svg\b[^>]*>)/, `$1<style>${motionCss(settings)}</style>`);
}

export interface MotionTrack {
  label: string;
  startMs: number;
  endMs: number;
}

/** One row per shape, capped so the timeline stays readable. */
export function motionTracks(shapeCount: number, input: MotionSettings, maxRows = 6): MotionTrack[] {
  const settings = clampMotionSettings(input);
  const rows = Math.min(shapeCount, maxRows);
  return Array.from({ length: rows }, (_value, row) => {
    const startMs = settings.delayMs + row * settings.staggerMs;
    return {
      label: shapeCount > maxRows && row === maxRows - 1 ? `Parts ${row + 1}–${shapeCount}` : `Part ${row + 1}`,
      startMs,
      endMs: startMs + settings.durationMs,
    };
  });
}

export function motionTotalMs(shapeCount: number, input: MotionSettings): number {
  const settings = clampMotionSettings(input);
  return settings.delayMs + Math.max(0, shapeCount - 1) * settings.staggerMs + settings.durationMs;
}
