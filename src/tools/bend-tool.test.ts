import { describe, expect, it } from 'vitest';
import type { Segment } from '../core/types';
import { canDirectBendSegment } from './bend-tool';

function segment(type: Segment['type'], role: Segment['role']): Segment {
  return {
    id: `${role}-${type}`,
    startNodeId: 'node-a',
    endNodeId: 'node-b',
    type,
    role,
  };
}

describe('direct path bending eligibility', () => {
  it('keeps common line and Bézier reshaping in Move mode', () => {
    expect(canDirectBendSegment(segment('line', 'geometry'))).toBe(true);
    expect(canDirectBendSegment(segment('bezier', 'geometry'))).toBe(true);
  });

  it('protects native arcs and construction references from silent conversion', () => {
    expect(canDirectBendSegment(segment('arc', 'geometry'))).toBe(false);
    expect(canDirectBendSegment(segment('line', 'construction'))).toBe(false);
    expect(canDirectBendSegment(undefined)).toBe(false);
  });
});
