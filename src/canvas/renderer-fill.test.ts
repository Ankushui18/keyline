import { describe, expect, it } from 'vitest';
import { fillPaint } from './renderer';
import type { AppearanceFill } from '../core/types';

/** Records the calls the renderer would make on a real 2D context. */
function recordingContext() {
  const calls: Array<Record<string, unknown>> = [];
  const gradient = (kind: string, arguments_: number[]) => ({
    kind,
    arguments: arguments_,
    stops: [] as Array<[number, string]>,
    addColorStop(offset: number, color: string) {
      this.stops.push([offset, color]);
    },
  });
  const context = {
    calls,
    createLinearGradient(...arguments_: number[]) {
      const result = gradient('linear', arguments_);
      calls.push({ kind: 'linear', arguments: arguments_, gradient: result });
      return result;
    },
    createRadialGradient(...arguments_: number[]) {
      const result = gradient('radial', arguments_);
      calls.push({ kind: 'radial', arguments: arguments_, gradient: result });
      return result;
    },
  };
  return context;
}

const stops = [
  { offset: 0, color: '#ff0000', opacity: 1 },
  { offset: 1, color: '#0000ff', opacity: 0.5 },
];

const paint = (fill: AppearanceFill) => fillPaint(recordingContext() as unknown as CanvasRenderingContext2D, fill) as
  { kind: string; arguments: number[]; stops: Array<[number, string]> } | string | undefined;

describe('canvas fill paint', () => {
  it('passes a solid colour straight through', () => {
    expect(paint({ type: 'solid', color: '#123456', opacity: 1, visible: true })).toBe('#123456');
  });

  it('builds a linear gradient in the object’s own coordinates, with stop opacity', () => {
    const result = paint({ type: 'linear', start: { x: 0, y: 10 }, end: { x: 100, y: 10 }, stops, opacity: 1, visible: true });
    expect(result).toMatchObject({ kind: 'linear', arguments: [0, 10, 100, 10] });
    expect(typeof result === 'object' && result !== null ? result.stops : []).toEqual([
      [0, '#ff0000'],
      [1, 'rgba(0, 0, 255, 0.5)'],
    ]);
  });

  it('builds a radial gradient from the centre outwards', () => {
    const result = paint({
      type: 'radial', center: { x: 7, y: 9 }, radius: 12, stops, opacity: 1, visible: true,
    });
    expect(result).toMatchObject({ kind: 'radial', arguments: [7, 9, 0, 7, 9, 12] });
  });

  it('refuses a degenerate gradient so the caller can fall back to its first stop', () => {
    expect(paint({ type: 'linear', start: { x: 5, y: 5 }, end: { x: 5, y: 5 }, stops, opacity: 1, visible: true })).toBeUndefined();
    expect(paint({ type: 'radial', center: { x: 0, y: 0 }, radius: 0, stops, opacity: 1, visible: true })).toBeUndefined();
  });
});
