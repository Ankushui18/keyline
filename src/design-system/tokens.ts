/**
 * Design-system tokens for JavaScript.
 *
 * CSS owns the values (`src/styles/system/tokens.css`); this module mirrors the
 * ones canvas code needs, so the 2D renderer, the WebGL renderer and the export
 * pipeline cannot drift from the DOM. `npm run check:design` compares the two
 * sources and fails if they disagree.
 *
 * These are resolved values, not `var(...)`: canvas and WebGL contexts cannot
 * read CSS custom properties.
 */

export const palette = {
  graphite1000: '#0e0f12',
  graphite950: '#111318',
  graphite900: '#141518',
  graphite875: '#17181a',
  graphite850: '#1f2023',
  graphite825: '#232529',
  graphite800: '#26272b',
  graphite775: '#2a2c31',
  graphite750: '#2e3036',
  graphite700: '#34363c',
  graphite650: '#3a3d44',
  graphite600: '#4a4d55',
  graphite550: '#5c5f67',
  graphite500: '#6b6e76',
  graphite450: '#8a8d95',
  graphite400: '#a0a3ab',
  graphite350: '#b4b8c0',
  graphite300: '#c9cbd1',
  graphite200: '#ececee',
  white: '#ffffff',
  black: '#000000',
  blue900: '#12233a',
  blue700: '#0868b6',
  blue600: '#0b7bd6',
  blue500: '#0d99ff',
  blue400: '#4fb0ff',
  blue300: '#74a0ff',
  red900: '#684148',
  red500: '#ef747c',
  green600: '#51c993',
  green500: '#7fd1a0',
  amber600: '#f5a623',
  amber500: '#e8a33d',
  cyan500: '#57c8d4',
  slate600: '#65738b',
  slate500: '#7183a1',
  violet500: '#a78bfa',
} as const;

/** Document canvas palette. The drawing surface stays light by design. */
export const canvasColors = {
  paper: '#e4e4e0',
  gridMinor: '#efefec',
  gridMajor: '#deded9',
  axis: '#b9b9b9',
  segment: '#6d737d',
} as const;

/** Editor chrome drawn by the renderers. */
export const editorColors = {
  selection: palette.blue500,
  selectionStrong: palette.blue700,
  handle: palette.blue500,
  node: palette.white,
  nodeCore: palette.white,
  segment: canvasColors.segment,
  guide: palette.violet500,
  presence: palette.slate500,
  artboardBorder: palette.graphite450,
  artboardBorderIdle: palette.graphite350,
  artboardLabel: palette.graphite200,
} as const;

/**
 * Transient tool overlays drawn by the canvas renderers. Mirrors the
 * `--overlay-*` tokens in tokens.css; the values are intentionally tool-specific
 * hues so a preview is recognisable regardless of the document's own colours.
 */
export const overlayColors = {
  shape: '#8b6cf6',
  shapeAdd: '#68a0ff',
  shapeSubtract: '#ef6b72',
  bend: '#b28cff',
  bendFill: '#1b1824',
  offset: '#82aaff',
  lasso: '#57c8d4',
  lassoFill: '#0e0e0e',
  width: '#c8892f',
  guide: '#a78bfa',
  guideFill: '#191622',
  importPreview: '#d8d8d8',
  importFill: '#d7d7d7',
  print: '#1f6feb',
  measure: '#f0b35b',
  construction: '#777777',
  constructionStrong: '#f2b968',
  muted: '#c8c8c8',
  bright: '#b99cff',
} as const;

/** Collaborator presence colours, assigned by index and stable per session. */
export const presenceColors = [
  palette.slate500,
  palette.violet500,
  palette.cyan500,
  palette.amber500,
  palette.green500,
  palette.blue400,
] as const;

/** Converts a token to an rgba() string; canvas needs alpha, CSS uses variables. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}
