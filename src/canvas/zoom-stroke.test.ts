import { describe, expect, it } from 'vitest';
import { canvasStrokeRenderWidths } from './renderer';
import { webGLStrokeRenderWidths } from './webgl-renderer';

describe('zoom-aware stroke rendering', () => {
  it('scales artwork width with the viewport while keeping Canvas selection feedback screen-constant', () => {
    const at100 = canvasStrokeRenderWidths(1, 1);
    const at412 = canvasStrokeRenderWidths(1, 4.12);

    expect(at100.artwork * 1).toBeCloseTo(1);
    expect(at412.artwork * 4.12).toBeCloseTo(4.12);
    expect(at100.selection * 1).toBeCloseTo(1.5);
    expect(at412.selection * 4.12).toBeCloseTo(1.5);
  });

  it('uses the same document-space artwork and screen-space selection rule in WebGL', () => {
    const at100 = webGLStrokeRenderWidths(1, 1, 1);
    const at412 = webGLStrokeRenderWidths(1, 1, 4.12);
    const transformed = webGLStrokeRenderWidths(1, 2, 4.12);

    expect(at100.artwork * 1).toBeCloseTo(1);
    expect(at412.artwork * 4.12).toBeCloseTo(4.12);
    expect(at412.selection * 4.12).toBeCloseTo(1.5);
    expect(transformed.artwork * 4.12).toBeCloseTo(8.24);
  });
});
