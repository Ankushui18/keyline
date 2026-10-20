/**
 * Defaults written into *documents*, not into the chrome.
 *
 * These values become user data: they are saved in snapshots, compared during
 * migration, and exported. They live here so the whole product starts from one
 * place, but they are deliberately separate from the UI palette — changing a
 * surface token must never rewrite someone's artwork.
 *
 * `npm run check:design` allows literals in this file only.
 */
import { palette } from './tokens';

/** Ink used for the first stroke a person draws. */
export const DEFAULT_STROKE_COLOR = '#c8ced9';
export const DEFAULT_STROKE_WIDTH = 1.25;
/** Fill used when a shape is created with filling enabled. */
export const DEFAULT_FILL_COLOR = '#8b6cf6';
/** Paper of a new artboard, before it is exported or recoloured. */
export const DEFAULT_ARTBOARD_BACKGROUND = '#ffffff';
/** Slightly darker paper used for the starter artboard on the canvas root. */
export const STARTER_ARTBOARD_BACKGROUND = '#e5e5e5';
/** Construction geometry defaults. */
export const CONSTRUCTION_STROKE_COLOR = '#777777';
export const CONSTRUCTION_ACTIVE_COLOR = '#f2b968';
export const CONSTRUCTION_ACTIVE_HALO = '#f0b35b';
/** Dim guide line drawn by the construction tool before a snap point lands. */
export const CONSTRUCTION_GUIDE_COLOR = '#bdbdbd';

/** Ink assumed for SVG geometry that arrives without an explicit colour. */
export const DEFAULT_IMPORT_INK = '#000000';
/** Ink used when drawing with the modern (non-legacy) drawing style. */
export const DEFAULT_DRAWING_INK = '#000000';
/** Deep navy stroke on the starter artwork that ships with a new document. */
export const STARTER_ARTWORK_STROKE = '#14181F';
/** Fill used by the properties panel when the first fill is added. */
export const DEFAULT_FIRST_FILL = DEFAULT_STROKE_COLOR;

/** Palette the command bar understands by name ("line color black"). */
export const NAMED_COLORS: Record<string, string> = {
  black: palette.graphite875,
  white: palette.white,
  red: '#e5484d',
  green: '#30a46c',
  blue: palette.blue500,
  orange: '#f76b15',
  yellow: '#f5d90a',
  purple: '#8e4ec6',
  pink: '#d6409f',
  gray: '#8b8d98',
  grey: '#8b8d98',
  teal: '#12a594',
};
