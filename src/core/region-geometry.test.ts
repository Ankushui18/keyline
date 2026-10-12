import { describe, expect, it } from 'vitest';
import {
  regionContainsPoint,
  signedPolygonArea,
  triangulateRegionLoops,
} from './region-geometry';
import type { FillRule, Point, Region, RegionBoundaryLoop } from './types';

const outer: Point[] = [
  { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 },
];
const hole: Point[] = [
  { x: 50, y: 50 }, { x: 50, y: 150 }, { x: 150, y: 150 }, { x: 150, y: 50 },
];

function loop(outline: Point[], prefix: string): RegionBoundaryLoop {
  return {
    outline,
    signedArea: signedPolygonArea(outline),
    boundarySegmentIds: outline.map((_, index) => `${prefix}-${index}`),
    boundaryEdges: [],
  };
}

function region(fillRule: FillRule, innerOutline = hole): Region {
  const outerLoop = loop(outer, 'outer');
  const innerLoop = loop(innerOutline, 'inner');
  return {
    id: 'compound',
    boundarySegmentIds: [...outerLoop.boundarySegmentIds, ...innerLoop.boundarySegmentIds],
    fillRule,
    outerLoop,
    innerLoops: [innerLoop],
    boundaryEdges: [],
    outline: outer,
    area: 30_000,
  };
}

function triangleArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 3) {
    const [a, b, c] = points.slice(index, index + 3);
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  return area;
}

describe('compound region geometry', () => {
  it('applies nonzero and evenodd semantics to oppositely wound hole loops', () => {
    for (const fillRule of ['nonzero', 'evenodd'] as const) {
      const compound = region(fillRule);
      expect(regionContainsPoint(compound, { x: 25, y: 25 })).toBe(true);
      expect(regionContainsPoint(compound, { x: 100, y: 100 })).toBe(false);
      const triangles = triangulateRegionLoops([outer, hole], fillRule);
      expect(triangles.length % 3).toBe(0);
      expect(triangleArea(triangles)).toBeCloseTo(30_000, 6);
    }
  });

  it('distinguishes same-winding nested rings under nonzero and evenodd rules', () => {
    const sameWindingInner = [...hole].reverse();
    const nonzero = region('nonzero', sameWindingInner);
    const evenodd = region('evenodd', sameWindingInner);
    expect(regionContainsPoint(nonzero, { x: 100, y: 100 })).toBe(true);
    expect(regionContainsPoint(evenodd, { x: 100, y: 100 })).toBe(false);
    expect(triangleArea(triangulateRegionLoops([outer, sameWindingInner], 'nonzero'))).toBeCloseTo(40_000, 6);
    expect(triangleArea(triangulateRegionLoops([outer, sameWindingInner], 'evenodd'))).toBeCloseTo(30_000, 6);
  });
});
