import { describe, expect, it } from 'vitest';
import { appearanceFromDrawingStyle, DEFAULT_DRAWING_STYLE, normalizeDrawingStyle, normalizeStoredDrawingStyle } from './drawing-style';

describe('persistent drawing styles', () => {
  it('uses a neutral one-pixel flat black stroke for new paths', () => {
    expect(DEFAULT_DRAWING_STYLE).toMatchObject({
      strokeColor: '#000000',
      strokeWidth: 1,
      strokeCap: 'butt',
      strokeJoin: 'round',
    });
  });

  it('updates the exact former default without overwriting customized saved styles', () => {
    expect(normalizeStoredDrawingStyle({
      strokeEnabled: true,
      strokeColor: '#c8ced9',
      strokeWidth: 1.25,
      strokeCap: 'round',
      strokeJoin: 'round',
      strokeAlignment: 'center',
      fillEnabled: false,
      fillColor: '#8b6cf6',
    })).toEqual(DEFAULT_DRAWING_STYLE);
    expect(normalizeStoredDrawingStyle({
      ...DEFAULT_DRAWING_STYLE,
      strokeColor: '#123456',
    }).strokeColor).toBe('#123456');
  });

  it('migrates legacy values to a visible centered stroke', () => {
    const migrated = normalizeDrawingStyle({
      strokeColor: '#123456',
      strokeWidth: 3,
      strokeCap: 'square',
      strokeJoin: 'bevel',
      fillEnabled: true,
      fillColor: '#abcdef',
    });
    expect(migrated).toMatchObject({
      strokeEnabled: true,
      strokeAlignment: 'center',
      strokeColor: '#123456',
      strokeWidth: 3,
    });
  });

  it.each(['inside', 'center', 'outside'] as const)('preserves %s stroke alignment in appearances', (strokeAlignment) => {
    const style = normalizeDrawingStyle({ ...DEFAULT_DRAWING_STYLE, strokeAlignment });
    expect(appearanceFromDrawingStyle('appearance-test', style).stroke).toMatchObject({
      alignment: strokeAlignment,
      visible: true,
    });
  });

  it('removes a stroke non-destructively and restores its retained attributes', () => {
    const hiddenStyle = normalizeDrawingStyle({
      ...DEFAULT_DRAWING_STYLE,
      strokeEnabled: false,
      strokeColor: '#aabbcc',
      strokeWidth: 7,
      strokeCap: 'butt',
      strokeJoin: 'miter',
      strokeAlignment: 'outside',
    });
    const hidden = appearanceFromDrawingStyle('appearance-test', hiddenStyle);
    expect(hidden.stroke).toMatchObject({
      visible: false,
      color: '#aabbcc',
      width: 7,
      cap: 'butt',
      join: 'miter',
      alignment: 'outside',
    });
    const restored = appearanceFromDrawingStyle('appearance-test', { ...hiddenStyle, strokeEnabled: true });
    expect(restored.stroke).toEqual({ ...hidden.stroke, visible: true });
  });

  it('normalizes invalid alignment without changing the established defaults', () => {
    const normalized = normalizeDrawingStyle({
      ...DEFAULT_DRAWING_STYLE,
      strokeAlignment: 'diagonal' as 'center',
    });
    expect(normalized.strokeAlignment).toBe('center');
  });
});
