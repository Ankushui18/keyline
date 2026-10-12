import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import {
  clipInfiniteLineToBounds,
  constructionLineGeometry,
  constructionLineSpan,
  projectPointToConstructionLine,
} from './construction-geometry';
import type { Segment, VectorNode, VectorPath } from './types';

function addConstructionLine(
  document: VectorDocument,
  manager: OperationManager,
  extent: 'finite' | 'infinite',
): { segment: Segment; nodes: VectorNode[] } {
  const networkId = document.activeNetwork.id;
  const nodes: VectorNode[] = [
    { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] },
    { id: createEntityId(), position: { x: 10, y: 0 }, constraintIds: [] },
  ];
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
  const segment: Segment = {
    id: createEntityId(),
    startNodeId: nodes[0].id,
    endNodeId: nodes[1].id,
    type: 'line',
    role: 'construction',
    constructionExtent: extent,
  };
  manager.beginTransaction('Construction fixture');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return { segment, nodes };
}

describe('construction line derived geometry', () => {
  it('projects to finite anchors but leaves infinite projection unbounded', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { segment } = addConstructionLine(document, manager, 'finite');
    const finite = constructionLineGeometry(document, segment.id)!;
    expect(projectPointToConstructionLine(finite, { x: 20, y: 3 })).toMatchObject({
      point: { x: 10, y: 0 }, t: 1,
    });
    expect(projectPointToConstructionLine(finite, { x: 20, y: 3 }).distance).toBeCloseTo(Math.hypot(10, 3));

    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: {
        segments: [{ segmentId: segment.id, role: 'construction', constructionExtent: 'infinite' }],
      },
    });
    const infinite = constructionLineGeometry(document, segment.id)!;
    expect(projectPointToConstructionLine(infinite, { x: 20, y: 3 })).toEqual({
      point: { x: 20, y: 0 }, t: 2, distance: 3,
    });
  });

  it('clips horizontal, vertical, and diagonal infinite lines to finite viewport bounds', () => {
    const bounds = { minX: -5, minY: -4, maxX: 15, maxY: 8 };
    expect(clipInfiniteLineToBounds({ x: 0, y: 2 }, { x: 10, y: 2 }, bounds)).toEqual({
      start: { x: -5, y: 2 }, end: { x: 15, y: 2 },
    });
    expect(clipInfiniteLineToBounds({ x: 3, y: 0 }, { x: 3, y: 10 }, bounds)).toEqual({
      start: { x: 3, y: -4 }, end: { x: 3, y: 8 },
    });
    expect(clipInfiniteLineToBounds({ x: 0, y: 0 }, { x: 10, y: 10 }, bounds)).toEqual({
      start: { x: -4, y: -4 }, end: { x: 8, y: 8 },
    });
    expect(clipInfiniteLineToBounds({ x: 20, y: 0 }, { x: 20, y: 10 }, bounds)).toBeNull();
  });

  it('uses transformed document-space anchors under rotation and non-uniform scale without graph mutation', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { segment } = addConstructionLine(document, manager, 'infinite');
    const object = document.getObjectForSegment(segment.id)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: object.id,
        updates: { transform: { x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 3 } },
      },
    });
    const before = JSON.stringify(document.toSnapshot());
    const line = constructionLineGeometry(document, segment.id)!;
    expect(line.start.x).toBeCloseTo(100);
    expect(line.start.y).toBeCloseTo(50);
    expect(line.end.x).toBeCloseTo(100);
    expect(line.end.y).toBeCloseTo(70);
    const projection = projectPointToConstructionLine(line, { x: 105, y: 100 });
    expect(projection.point.x).toBeCloseTo(100);
    expect(projection.point.y).toBeCloseTo(100);
    expect(projection.t).toBeCloseTo(2.5);
    expect(projection.distance).toBeCloseTo(5);
    expect(constructionLineSpan(line, { minX: 80, minY: 0, maxX: 120, maxY: 120 })).toEqual({
      start: { x: 100, y: 0 }, end: { x: 100, y: 120 },
    });
    expect(JSON.stringify(document.toSnapshot())).toBe(before);
  });

  it('returns authoritative finite anchors without extending them to viewport bounds', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { segment } = addConstructionLine(document, manager, 'finite');
    const line = constructionLineGeometry(document, segment.id)!;
    expect(constructionLineSpan(line, { minX: 3, minY: -1, maxX: 7, maxY: 1 })).toEqual({
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    });
  });
});
