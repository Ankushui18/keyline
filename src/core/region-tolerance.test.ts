import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { detectRegionsDetailed } from './regions';
import type { DocumentSnapshot, Segment, VectorNode } from './types';

function pairedSegments(kind: Segment['type'], offset = 5e-6): VectorDocument {
  const firstStart: VectorNode = {
    id: 'n-a0', position: { x: 0, y: 0 }, constraintIds: [],
    handleOut: kind === 'bezier' ? { x: 30, y: 40 } : undefined,
  };
  const firstEnd: VectorNode = {
    id: 'n-a1', position: { x: 100, y: 0 }, constraintIds: [],
    handleIn: kind === 'bezier' ? { x: 70, y: 40 } : undefined,
  };
  const secondStart: VectorNode = {
    id: 'n-b0', position: { x: 0, y: offset }, constraintIds: [],
    handleOut: kind === 'bezier' ? { x: 30, y: 40 + offset } : undefined,
  };
  const secondEnd: VectorNode = {
    id: 'n-b1', position: { x: 100, y: offset }, constraintIds: [],
    handleIn: kind === 'bezier' ? { x: 70, y: 40 + offset } : undefined,
  };
  const geometry = kind === 'arc'
    ? { center: { x: 50, y: 0 }, radius: 50, startAngle: Math.PI, endAngle: 0, clockwise: true }
    : {};
  const shiftedGeometry = kind === 'arc'
    ? { center: { x: 50, y: offset }, radius: 50, startAngle: Math.PI, endAngle: 0, clockwise: true }
    : {};
  const first: Segment = {
    id: 's-a', startNodeId: firstStart.id, endNodeId: firstEnd.id, type: kind, role: 'geometry', ...geometry,
  };
  const second: Segment = {
    id: 's-b', startNodeId: secondStart.id, endNodeId: secondEnd.id, type: kind, role: 'geometry', ...shiftedGeometry,
  };
  const snapshot: DocumentSnapshot = {
    version: 6,
    id: `tolerance-${kind}`,
    networks: [{ id: 'network', nodeIds: [firstStart.id, firstEnd.id, secondStart.id, secondEnd.id], pathIds: ['p-a', 'p-b'] }],
    nodes: [[firstStart.id, firstStart], [firstEnd.id, firstEnd], [secondStart.id, secondStart], [secondEnd.id, secondEnd]],
    segments: [[first.id, first], [second.id, second]],
    paths: [
      ['p-a', { id: 'p-a', segmentIds: [first.id], isClosed: false }],
      ['p-b', { id: 'p-b', segmentIds: [second.id], isClosed: false }],
    ],
    regions: [],
    variables: [],
  };
  return new VectorDocument(snapshot);
}

describe('deterministic near-coincident region tolerance', () => {
  for (const kind of ['line', 'bezier', 'arc'] as const) {
    it(`diagnoses near-coincident ${kind} boundaries deterministically`, () => {
      const document = pairedSegments(kind);
      const first = detectRegionsDetailed(document);
      const second = detectRegionsDetailed(document);
      expect(first).toEqual(second);
      expect(first.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'ambiguous-overlap', segmentIds: ['s-a', 's-b'] }),
      ]));
      expect(Object.values(first.stats).every(Number.isFinite)).toBe(true);
    });
  }
});
