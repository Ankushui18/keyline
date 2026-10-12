import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Segment, VectorNode, VectorPath } from '../core/types';
import { localEraseSpan, prepareEraseSegment } from './eraser-tool';

function lineFixture(role: Segment['role'] = 'geometry') {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const start: VectorNode = { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] };
  const end: VectorNode = { id: createEntityId(), position: { x: 100, y: 0 }, constraintIds: [] };
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
  const segment: Segment = {
    id: createEntityId(),
    startNodeId: start.id,
    endNodeId: end.id,
    type: 'line',
    role,
    constructionExtent: role === 'construction' ? 'finite' : undefined,
  };
  manager.execute({ type: 'ADD_NODE', payload: { node: start, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_NODE', payload: { node: end, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId: document.activeNetwork.id } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  return { document, manager, start, end, path, segment };
}

describe('local path erasing', () => {
  it('maps a click to a short span instead of the whole segment', () => {
    const { document, segment } = lineFixture();
    const span = localEraseSpan(document, segment.id, { x: 50, y: 2 }, 10);
    expect(span?.startT).toBeCloseTo(0.4, 2);
    expect(span?.endT).toBeCloseTo(0.6, 2);
  });

  it('clips the erased span at endpoints and protects construction references', () => {
    const geometry = lineFixture();
    expect(localEraseSpan(geometry.document, geometry.segment.id, { x: 2, y: 0 }, 12)).toMatchObject({ startT: 0 });
    const construction = lineFixture('construction');
    expect(localEraseSpan(construction.document, construction.segment.id, { x: 50, y: 0 }, 10)).toBeNull();
  });

  it('removes endpoints that become orphaned instead of leaving points on the canvas', () => {
    const { document, manager, start, end, segment } = lineFixture();
    const erase = prepareEraseSegment(document, segment.id, true)!;
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: erase.patch });
    expect(document.getSegment(segment.id)).toBeUndefined();
    expect(document.getNode(start.id)).toBeUndefined();
    expect(document.getNode(end.id)).toBeUndefined();
    manager.undo();
    expect(document.getNode(start.id)).toBeDefined();
    expect(document.getNode(end.id)).toBeDefined();
  });
});
