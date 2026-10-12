import { describe, expect, it } from 'vitest';
import { parseSvgPathData } from './svg-import';

describe('SVG path import', () => {
  it('keeps relative line geometry closed and editable', () => {
    const [path] = parseSvgPathData('M 2 3 h 10 v 8 h -10 z');
    expect(path.isClosed).toBe(true);
    expect(path.nodes.map((node) => node.position)).toEqual([
      { x: 2, y: 3 }, { x: 12, y: 3 }, { x: 12, y: 11 }, { x: 2, y: 11 },
    ]);
    expect(path.segments).toHaveLength(4);
    expect(path.segments.every((segment) => segment.type === 'line')).toBe(true);
  });

  it('converts cubic, smooth, quadratic, and reflected commands to Bézier segments', () => {
    const [path] = parseSvgPathData('M0 0 C10 0 10 10 20 10 S30 20 40 10 Q50 0 60 10 T80 10');
    expect(path.segments).toHaveLength(4);
    expect(path.segments.every((segment) => segment.type === 'bezier')).toBe(true);
    expect(path.nodes[1].handleOut).toEqual({ x: 30, y: 10 });
    expect(path.nodes[4].position).toEqual({ x: 80, y: 10 });
    expect(path.nodes.flatMap((node) => [node.position, node.handleIn, node.handleOut]).filter(Boolean)
      .every((point) => Number.isFinite(point!.x) && Number.isFinite(point!.y))).toBe(true);
  });

  it('converts elliptical arcs into finite cubic Bézier segments with exact endpoints', () => {
    const [path] = parseSvgPathData('M10 20 A30 15 25 1 1 90 70');
    expect(path.segments.length).toBeGreaterThanOrEqual(2);
    expect(path.segments.every((segment) => segment.type === 'bezier')).toBe(true);
    expect(path.nodes.at(-1)?.position.x).toBeCloseTo(90, 8);
    expect(path.nodes.at(-1)?.position.y).toBeCloseTo(70, 8);
    for (const node of path.nodes) {
      for (const point of [node.position, node.handleIn, node.handleOut].filter(Boolean)) {
        expect(Number.isFinite(point!.x) && Number.isFinite(point!.y)).toBe(true);
      }
    }
  });

  it('preserves multiple subpaths from one SVG path element', () => {
    const paths = parseSvgPathData('M0 0L10 0L10 10Z M3 3L7 3L7 7Z');
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.isClosed)).toBe(true);
  });
});
