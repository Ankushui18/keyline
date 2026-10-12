import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Segment, VectorNode, VectorPath } from '../core/types';
import { concreteDocumentSegments } from '../export/svg-export';
import { webGLAlignedStrokeVertexData } from './webgl-renderer';

function squareFixture() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const nodes = points.map((position): VectorNode => ({ id: createEntityId(), position, constraintIds: [] }));
  const segments = nodes.map((node, index): Segment => ({
    id: createEntityId(), startNodeId: node.id, endNodeId: nodes[(index + 1) % nodes.length].id,
    type: 'line', role: 'geometry',
  }));
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: true };
  const networkId = document.activeNetwork.id;
  manager.beginTransaction('Square fixture');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  segments.forEach((segment) => manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } }));
  manager.commitTransaction();
  const concrete = concreteDocumentSegments(document).find((item) => item.segment.id === segments[0].id)!;
  return { document, concrete };
}

function pointsFromVertices(vertices: number[]) {
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < vertices.length; index += 6) points.push({ x: vertices[index], y: vertices[index + 1] });
  return points;
}

describe('WebGL stroke alignment parity', () => {
  it('clips a doubled closed-path stroke to the inside half', () => {
    const { document, concrete } = squareFixture();
    const vertices = webGLAlignedStrokeVertexData(document, concrete, 4, 'inside', 'butt');
    const points = pointsFromVertices(vertices);
    expect(vertices.length).toBeGreaterThan(0);
    expect(vertices.length % 18).toBe(0);
    expect(vertices.every(Number.isFinite)).toBe(true);
    expect(Math.min(...points.map((point) => point.y))).toBeGreaterThanOrEqual(-0.001);
    expect(Math.max(...points.map((point) => point.y))).toBeLessThanOrEqual(4.001);
  });

  it('clips a doubled closed-path stroke to the outside half', () => {
    const { document, concrete } = squareFixture();
    const vertices = webGLAlignedStrokeVertexData(document, concrete, 4, 'outside', 'butt');
    const points = pointsFromVertices(vertices);
    expect(vertices.length).toBeGreaterThan(0);
    expect(vertices.length % 18).toBe(0);
    expect(vertices.every(Number.isFinite)).toBe(true);
    const interiorPoints = points.filter((point) => point.x > 0.001 && point.x < 19.999);
    expect(Math.min(...points.map((point) => point.y))).toBeGreaterThanOrEqual(-4.001);
    expect(Math.max(...interiorPoints.map((point) => point.y))).toBeLessThanOrEqual(0.001);
  });
});
