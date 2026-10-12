import { describe, expect, it } from 'vitest';
import { SpatialIndex } from './spatial-index';

describe('WebGL spatial index', () => {
  it('culls a 10,000-item scene to the visible bounds', () => {
    const started = performance.now();
    const index = new SpatialIndex<number>({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    for (let y = 0; y < 100; y += 1) {
      for (let x = 0; x < 100; x += 1) {
        const value = y * 100 + x;
        index.insert({ minX: x * 10, minY: y * 10, maxX: x * 10 + 2, maxY: y * 10 + 2, value });
      }
    }
    const visible = index.query({ minX: 100, minY: 100, maxX: 200, maxY: 200 });
    expect(visible.length).toBeGreaterThan(90);
    expect(visible.length).toBeLessThan(150);
    expect(new Set(visible).size).toBe(visible.length);
    for (let frame = 0; frame < 120; frame += 1) {
      index.query({ minX: frame * 2, minY: frame * 2, maxX: frame * 2 + 100, maxY: frame * 2 + 100 });
    }
    // Includes index construction plus two seconds' worth of 60fps culling queries.
    expect(performance.now() - started).toBeLessThan(1200);
  });

  it('retains items spanning multiple quadrants', () => {
    const index = new SpatialIndex<string>({ minX: -100, minY: -100, maxX: 100, maxY: 100 }, 1);
    index.insert({ minX: -20, minY: -20, maxX: 20, maxY: 20, value: 'center' });
    index.insert({ minX: 50, minY: 50, maxX: 60, maxY: 60, value: 'corner' });
    expect(index.query({ minX: -1, minY: -1, maxX: 1, maxY: 1 })).toEqual(['center']);
  });

  it('rejects non-finite, inverted, and giant-infinity bounds defensively', () => {
    const index = new SpatialIndex<string>({ minX: -100, minY: -100, maxX: 100, maxY: 100 });
    index.insert({ minX: 0, minY: 0, maxX: 1, maxY: 1, value: 'finite' });
    index.insert({ minX: Number.NEGATIVE_INFINITY, minY: 0, maxX: Number.POSITIVE_INFINITY, maxY: 1, value: 'infinite' });
    index.insert({ minX: Number.NaN, minY: 0, maxX: 1, maxY: 1, value: 'nan' });
    index.insert({ minX: 5, minY: 5, maxX: -5, maxY: -5, value: 'inverted' });
    expect(index.query({ minX: -10, minY: -10, maxX: 10, maxY: 10 })).toEqual(['finite']);
    expect(index.query({ minX: -Infinity, minY: -10, maxX: 10, maxY: 10 })).toEqual([]);
  });
});
