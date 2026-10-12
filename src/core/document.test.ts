import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { OperationManager } from './operations';
import type { VectorNode } from './types';

describe('VectorDocument serialization', () => {
  it('round-trips maps and nested geometry without shared references', () => {
    const original = VectorDocument.createEmpty();
    const manager = new OperationManager(original);
    const node: VectorNode = {
      id: 'node-a',
      position: { x: 12.5, y: -4 },
      handleOut: { x: 20, y: 3 },
      constraintIds: [],
    };
    manager.execute({ type: 'ADD_NODE', payload: { node, networkId: original.activeNetwork.id } });
    const constraint = {
      id: 'constraint-a',
      type: 'coincident' as const,
      priority: 'soft' as const,
      targetIds: [node.id, node.id],
      tolerance: 1e-6,
    };
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint } });

    const restored = new VectorDocument(original.toSnapshot());
    expect(restored.getNode(node.id)).toEqual(original.getNode(node.id));
    expect(restored.constraints.get(constraint.id)).toEqual(constraint);
    expect(restored.nodes).toBeInstanceOf(Map);
    expect(restored.getNode(node.id)).not.toBe(original.getNode(node.id));
  });
});
