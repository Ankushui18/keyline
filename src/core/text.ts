import type { Point, TextAlign, TextContent, TextFamily, TextWeight } from './types';

/**
 * Text layout (docs/EDITING-AUDIT.md §3.9, slice 1).
 *
 * Content and style are the model; everything here is derived. Nothing measured is ever
 * stored on the document, so a file opened on another machine lays out in that machine's
 * fonts instead of carrying stale pixel widths.
 *
 * Measurement comes from a provider. The app installs a canvas-backed one so the box matches
 * the glyphs the user sees; node and the test suite get the deterministic fallback below, so
 * geometry, bounds and export can be asserted to the digit.
 */

export const TEXT_FAMILIES: readonly TextFamily[] = ['sans', 'serif', 'mono'];
export const TEXT_WEIGHTS: readonly TextWeight[] = [400, 500, 600, 700];
export const TEXT_ALIGNMENTS: readonly TextAlign[] = ['left', 'center', 'right'];

export const MIN_TEXT_SIZE = 4;
export const MAX_TEXT_SIZE = 512;
export const MIN_LINE_HEIGHT = 0.5;
export const MAX_LINE_HEIGHT = 4;

/** The CSS stacks the three families stand for. One list, used by canvas, panel and SVG. */
export const TEXT_FONT_STACKS: Record<TextFamily, string> = {
  sans: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
  serif: 'Georgia, Times New Roman, serif',
  mono: 'SFMono-Regular, Consolas, Liberation Mono, monospace',
};

export const DEFAULT_TEXT: TextContent = {
  content: 'Text',
  family: 'sans',
  size: 24,
  weight: 400,
  lineHeight: 1.25,
  align: 'left',
};

/** Baselines sit this far down each line box; shared by canvas, inspector maths and export. */
export const TEXT_BASELINE_RATIO = 0.8;

export interface TextLine {
  text: string;
  /** Measured advance width at the object's scale. */
  width: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** Widest line; the box width. */
  width: number;
  /** `lines.length * size * lineHeight`. */
  height: number;
  size: number;
  lineHeight: number;
  align: TextAlign;
  /** The x offset of a line's left edge inside the box. */
  lineLeft: (line: TextLine) => number;
  /** Where the box's top edge sits relative to the first line's baseline. */
  firstBaselineOffset: number;
  /** Baseline y of a line, measured from the box's top edge. */
  baseline: (index: number) => number;
}

export type TextMetricsProvider = (line: string, text: TextContent) => number;

export function clampTextSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEXT.size;
  return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, value));
}

export function clampLineHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEXT.lineHeight;
  return Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, value));
}

export function clampTextWeight(value: number): TextWeight {
  if (!Number.isFinite(value)) return DEFAULT_TEXT.weight;
  return TEXT_WEIGHTS.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest, DEFAULT_TEXT.weight);
}

export function isTextFamily(value: unknown): value is TextFamily {
  return typeof value === 'string' && (TEXT_FAMILIES as readonly string[]).includes(value);
}

export function isTextAlign(value: unknown): value is TextAlign {
  return typeof value === 'string' && (TEXT_ALIGNMENTS as readonly string[]).includes(value);
}

/**
 * Fills in defaults and clamps every field. Returns `undefined` for "not a text object", which
 * is how a missing field stays missing instead of becoming an empty text run.
 */
export function normalizeTextContent(input: Partial<TextContent> | undefined): TextContent | undefined {
  if (!input) return undefined;
  return {
    content: typeof input.content === 'string' ? input.content : DEFAULT_TEXT.content,
    family: isTextFamily(input.family) ? input.family : DEFAULT_TEXT.family,
    size: clampTextSize(typeof input.size === 'number' ? input.size : DEFAULT_TEXT.size),
    weight: clampTextWeight(typeof input.weight === 'number' ? input.weight : DEFAULT_TEXT.weight),
    lineHeight: clampLineHeight(typeof input.lineHeight === 'number' ? input.lineHeight : DEFAULT_TEXT.lineHeight),
    align: isTextAlign(input.align) ? input.align : DEFAULT_TEXT.align,
  };
}

export function cloneTextContent(text: TextContent): TextContent {
  return { ...text };
}

/** Explicit newlines only; an empty string is one empty line, never zero lines. */
export function textLines(content: string): string[] {
  return content.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Deterministic metrics for environments without a canvas: per-character widths in em, with
 * the obvious narrow and wide glyphs singled out. Not typographically exact — it exists so
 * tests and headless exports have stable, explainable numbers.
 */
export function fallbackTextWidth(line: string, text: TextContent): number {
  if (line.length === 0) return 0;
  if (text.family === 'mono') return line.length * 0.6 * text.size;
  const narrow = new Set(' iljI.,:;!\'|');
  const wide = new Set('mwMW@');
  let em = 0;
  for (const character of line) {
    if (character === ' ') em += 0.28;
    else if (narrow.has(character)) em += 0.28;
    else if (wide.has(character)) em += 0.85;
    else if (character >= 'A' && character <= 'Z') em += 0.66;
    else em += 0.55;
  }
  const familyFactor = text.family === 'serif' ? 0.97 : 1;
  const weightFactor = text.weight >= 600 ? 1.02 : 1;
  return em * text.size * familyFactor * weightFactor;
}

let provider: TextMetricsProvider = fallbackTextWidth;

/** Install a measuring function. Passing `undefined` restores the deterministic fallback. */
export function setTextMetricsProvider(next: TextMetricsProvider | undefined): void {
  provider = next ?? fallbackTextWidth;
}

export function textMetricsProvider(): TextMetricsProvider {
  return provider;
}

/** The CSS font shorthand for a run, shared by the canvas renderer and the inspector preview. */
export function textCssFont(text: TextContent): string {
  return `${text.weight} ${text.size}px ${TEXT_FONT_STACKS[text.family]}`;
}

export function layoutText(input: TextContent): TextLayout {
  const text = normalizeTextContent(input) ?? DEFAULT_TEXT;
  const lines = textLines(text.content).map((line) => ({ text: line, width: provider(line, text) }));
  const measured = Math.max(0, ...lines.map((line) => line.width));
  // An empty text object keeps a caret-width box, so it stays visible and selectable.
  const width = measured > 0 ? measured : text.size * 0.6;
  const lineBox = text.size * text.lineHeight;
  const height = Math.max(lineBox, lines.length * lineBox);
  return {
    lines,
    width,
    height,
    size: text.size,
    lineHeight: text.lineHeight,
    align: text.align,
    lineLeft: (line) => {
      if (text.align === 'center') return (width - line.width) / 2;
      if (text.align === 'right') return width - line.width;
      return 0;
    },
    firstBaselineOffset: lineBox * TEXT_BASELINE_RATIO,
    baseline: (index) => index * lineBox + lineBox * TEXT_BASELINE_RATIO,
  };
}

/** The text box in object-local space: origin top-left, at the object transform's origin. */
export function textLocalBounds(text: TextContent): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  const layout = layoutText(text);
  return { minX: 0, minY: 0, maxX: layout.width, maxY: layout.height, width: layout.width, height: layout.height };
}

/** The four corners of a text box, in the order the rest of the geometry code expects points. */
export function textBoxCorners(text: TextContent): Point[] {
  const bounds = textLocalBounds(text);
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
}
