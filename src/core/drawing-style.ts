import type { Appearance, DrawingStyle, EntityId } from './types';

const LEGACY_DEFAULT_DRAWING_STYLE: DrawingStyle = {
  strokeEnabled: true,
  strokeColor: '#c8ced9',
  strokeWidth: 1.25,
  strokeCap: 'round',
  strokeJoin: 'round',
  strokeAlignment: 'center',
  fillEnabled: false,
  fillColor: '#8b6cf6',
};

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
  strokeEnabled: true,
  strokeColor: '#000000',
  strokeWidth: 1,
  strokeCap: 'butt',
  strokeJoin: 'round',
  strokeAlignment: 'center',
  fillEnabled: false,
  fillColor: '#8b6cf6',
};

export function appearanceFromDrawingStyle(id: EntityId, style: DrawingStyle): Appearance {
  return {
    id,
    fills: style.fillEnabled
      ? [{ type: 'solid', color: style.fillColor, opacity: 1, visible: true }]
      : [],
    stroke: {
      color: style.strokeColor,
      width: style.strokeWidth,
      cap: style.strokeCap,
      join: style.strokeJoin,
      alignment: style.strokeAlignment,
      opacity: 1,
      dash: [],
      visible: style.strokeEnabled,
    },
    opacity: 1,
  };
}

export function normalizeDrawingStyle(value: Partial<DrawingStyle> | undefined): DrawingStyle {
  const style = { ...DEFAULT_DRAWING_STYLE, ...value };
  return {
    strokeEnabled: style.strokeEnabled !== false,
    strokeColor: /^#[0-9a-f]{6}$/i.test(style.strokeColor) ? style.strokeColor : DEFAULT_DRAWING_STYLE.strokeColor,
    strokeWidth: Number.isFinite(style.strokeWidth) && style.strokeWidth > 0 ? Math.min(style.strokeWidth, 512) : DEFAULT_DRAWING_STYLE.strokeWidth,
    strokeCap: style.strokeCap === 'butt' || style.strokeCap === 'round' || style.strokeCap === 'square'
      ? style.strokeCap
      : DEFAULT_DRAWING_STYLE.strokeCap,
    strokeJoin: style.strokeJoin === 'miter' || style.strokeJoin === 'round' || style.strokeJoin === 'bevel'
      ? style.strokeJoin
      : DEFAULT_DRAWING_STYLE.strokeJoin,
    strokeAlignment: style.strokeAlignment === 'inside' || style.strokeAlignment === 'outside' ? style.strokeAlignment : 'center',
    fillEnabled: Boolean(style.fillEnabled),
    fillColor: /^#[0-9a-f]{6}$/i.test(style.fillColor) ? style.fillColor : DEFAULT_DRAWING_STYLE.fillColor,
  };
}

/** Updates only the exact former default; user-customized persisted styles are preserved. */
export function normalizeStoredDrawingStyle(value: Partial<DrawingStyle> | undefined): DrawingStyle {
  const normalized = normalizeDrawingStyle(value);
  const isLegacyDefault = (Object.keys(LEGACY_DEFAULT_DRAWING_STYLE) as Array<keyof DrawingStyle>)
    .every((key) => normalized[key] === LEGACY_DEFAULT_DRAWING_STYLE[key]);
  return isLegacyDefault ? { ...DEFAULT_DRAWING_STYLE } : normalized;
}
