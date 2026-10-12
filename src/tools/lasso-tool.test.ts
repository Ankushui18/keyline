import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import type { VectorNode } from '../core/types';
import { prepareBulkNodePositions } from './lasso-tool';

describe('bulk node symmetry', () => {
  it('pairs rectangle corners by mirrored vertical position without collapsing the region', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const networkId = document.activeNetwork.id;
    const nodes: VectorNode[] = [
      { id: 'node-a', position: { x: 0, y: 0 }, constraintIds: [] },
      { id: 'node-b', position: { x: 100, y: 0 }, constraintIds: [] },
      { id: 'node-c', position: { x: 100, y: 80 }, constraintIds: [] },
      { id: 'node-d', position: { x: 0, y: 80 }, constraintIds: [] },
    ];
    for (const node of nodes) manager.execute({ type: 'ADD_NODE', payload: { node, networkId } });

    const positions = prepareBulkNodePositions(document, nodes.map((node) => node.id), 'symmetry');
    const byId = new Map(positions.map((item) => [item.nodeId, item.position]));

    expect(byId.get('node-a')).toEqual({ x: 0, y: 0 });
    expect(byId.get('node-b')).toEqual({ x: 100, y: 0 });
    expect(byId.get('node-c')).toEqual({ x: 100, y: 80 });
    expect(byId.get('node-d')).toEqual({ x: 0, y: 80 });
  });
});
