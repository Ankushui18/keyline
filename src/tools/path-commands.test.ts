import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { VectorNode, VectorPath, Segment } from '../core/types';
import { preparePrimitiveObject } from './primitive-tool';
import { connectedSelection, prepareClosePath, prepareDeletePoint, prepareJoinEndpoints, prepareReversePath } from './path-commands';

function commit(document: VectorDocument, manager: OperationManager, kind: 'line' | 'arc') {
  const plan = preparePrimitiveObject(document, kind, { x: 0, y: 0 }, { x: 100, y: 60 })!;
  manager.beginTransaction(`Create ${kind}`);
  plan.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return plan;
}

describe('professional path commands', () => {
  it('closes an open path with new topology and undoes the whole command', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = commit(document, manager, 'line');
    const operations = prepareClosePath(document, plan.pathId)!;
    manager.beginTransaction('Close path');
    operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    expect(document.getPath(plan.pathId)).toMatchObject({ isClosed: true });
    expect(document.getPath(plan.pathId)?.segmentIds).toHaveLength(2);
    manager.undo();
    expect(document.getPath(plan.pathId)).toMatchObject({ isClosed: false });
    expect(document.getPath(plan.pathId)?.segmentIds).toHaveLength(1);
  });

  it('reverses native arcs while preserving segment IDs and restores on undo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = commit(document, manager, 'arc');
    const original = { ...document.getSegment(plan.segmentIds[0])! };
    const patch = prepareReversePath(document, plan.pathId)!;
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: patch });
    const reversed = document.getSegment(original.id)!;
    expect(reversed.id).toBe(original.id);
    expect(reversed.startNodeId).toBe(original.endNodeId);
    expect(reversed.endNodeId).toBe(original.startNodeId);
    expect(reversed.startAngle).toBe(original.endAngle);
    manager.undo();
    expect(document.getSegment(original.id)).toMatchObject(original);
  });

  it('deletes a one-segment path without leaving an orphan point and restores it on undo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = commit(document, manager, 'line');
    const segment = document.getSegment(plan.segmentIds[0])!;
    const endpoint = segment.startNodeId;
    const oppositeEndpoint = segment.endNodeId;
    const deletion = prepareDeletePoint(document, endpoint)!;
    expect(deletion.deleteObjectId).toBe(plan.objectId);
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: deletion.patch });
    expect(document.getNode(endpoint)).toBeUndefined();
    expect(document.getNode(oppositeEndpoint)).toBeUndefined();
    expect(document.getPath(plan.pathId)).toBeUndefined();
    manager.undo();
    expect(document.getNode(endpoint)).toBeDefined();
    expect(document.getNode(oppositeEndpoint)).toBeDefined();
    expect(document.getPath(plan.pathId)?.segmentIds).toEqual(plan.segmentIds);
  });

  it('joins two open paths in the same network while preserving their segment IDs', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const networkId = document.activeNetwork.id;
    const makePath = (x: number) => {
      const nodes: VectorNode[] = [{ x, y: 0 }, { x: x + 20, y: 0 }].map((position) => ({ id: createEntityId(), position, constraintIds: [] }));
      const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
      const segment: Segment = { id: createEntityId(), startNodeId: nodes[0].id, endNodeId: nodes[1].id, type: 'line', role: 'geometry' };
      nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
      manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
      manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
      return { nodes, path, segment };
    };
    const first = makePath(0);
    const second = makePath(40);
    const operations = prepareJoinEndpoints(document, first.nodes[1].id, second.nodes[0].id)!;
    manager.beginTransaction('Join');
    operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    expect(document.getPath(first.path.id)?.segmentIds).toHaveLength(3);
    expect(document.getPath(second.path.id)).toBeUndefined();
    expect(document.getSegment(first.segment.id)).toBeDefined();
    expect(document.getSegment(second.segment.id)).toBeDefined();
    manager.undo();
    expect(document.getPath(second.path.id)?.segmentIds).toEqual([second.segment.id]);
  });

  it('selects an entire connected subnetwork without mutating the document', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = commit(document, manager, 'line');
    const before = document.toSnapshot();
    const selection = connectedSelection(document, [first.segmentIds[0]]);
    expect(selection.segmentIds).toEqual(first.segmentIds);
    expect(selection.nodeIds).toHaveLength(2);
    expect(document.toSnapshot()).toEqual(before);
  });
});
