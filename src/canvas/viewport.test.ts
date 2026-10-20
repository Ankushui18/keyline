import { describe, expect, it } from 'vitest';
import { Viewport, wheelIntent } from './viewport';

describe('Viewport', () => {
  it('places the world origin at the center of the available canvas', () => {
    const viewport = new Viewport();
    viewport.centerOn(1000, 600);
    expect(viewport.worldToScreen({ x: 0, y: 0 })).toEqual({ x: 500, y: 300 });
  });

  it('supports precision zoom up to 20,000 percent', () => {
    const viewport = new Viewport();
    viewport.zoomAt({ x: 250, y: 180 }, 1_000);
    expect(viewport.scale).toBe(200);
    expect(viewport.worldToScreen(viewport.screenToWorld({ x: 250, y: 180 }))).toEqual({ x: 250, y: 180 });
  });

  it('fits and centers object bounds with canvas padding', () => {
    const viewport = new Viewport();
    viewport.fitBounds({ minX: 100, minY: 50, maxX: 300, maxY: 150 }, 1000, 700, 100);
    expect(viewport.scale).toBe(4);
    expect(viewport.worldToScreen({ x: 200, y: 100 })).toEqual({ x: 500, y: 350 });
    expect(viewport.worldToScreen({ x: 100, y: 50 })).toEqual({ x: 100, y: 150 });
  });

  it('pans on a plain wheel gesture, matching a two-finger scroll', () => {
    expect(wheelIntent({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false }, 800))
      .toEqual({ kind: 'pan', deltaX: 0, deltaY: 120 });
  });

  it('maps a shift wheel onto the horizontal axis', () => {
    expect(wheelIntent({ deltaX: 0, deltaY: 90, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: true }, 800))
      .toEqual({ kind: 'pan', deltaX: 90, deltaY: 0 });
  });

  it('zooms only with ctrl or cmd held, which is also how a pinch arrives', () => {
    const zoom = wheelIntent({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false }, 800);
    expect(zoom.kind).toBe('zoom');
    if (zoom.kind !== 'zoom') throw new Error('expected zoom');
    expect(zoom.factor).toBeGreaterThan(1);
    expect(wheelIntent({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: true, shiftKey: false }, 800).kind).toBe('zoom');
  });

  it('converts line and page deltas and applies them through panBy', () => {
    const viewport = new Viewport();
    const line = wheelIntent({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false, metaKey: false, shiftKey: false }, 800);
    expect(line).toEqual({ kind: 'pan', deltaX: 0, deltaY: 48 });
    const page = wheelIntent({ deltaX: 0, deltaY: 1, deltaMode: 2, ctrlKey: false, metaKey: false, shiftKey: false }, 800);
    expect(page).toEqual({ kind: 'pan', deltaX: 0, deltaY: 800 });
    if (line.kind === 'pan') viewport.panBy(-line.deltaX, -line.deltaY);
    expect(viewport.offsetY).toBe(-48);
  });
});
