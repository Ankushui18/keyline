import { describe, expect, it } from 'vitest';
import { Viewport } from './viewport';

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
});
