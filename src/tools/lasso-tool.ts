import type { VectorDocument } from '../core/document';
import type { EntityId, Point } from '../core/types';

export type BulkNodeAction = 'horizontal' | 'vertical' | 'distribute' | 'symmetry';

export function prepareBulkNodePositions(
  document: VectorDocument,
  nodeIds: Iterable<EntityId>,
  action: BulkNodeAction,
): Array<{ nodeId: EntityId; position: Point }> {
  const nodes = [...nodeIds]
    .map((id) => document.getNode(id))
    .filter((node) => node !== undefined)
    .map((node) => ({ id: node.id, position: { ...node.position } }));
  if (nodes.length < 2) return [];
  if (action === 'horizontal') {
    const y = nodes.reduce((sum, node) => sum + node.position.y, 0) / nodes.length;
    return nodes.map((node) => ({ nodeId: node.id, position: { x: node.position.x, y } }));
  }
  if (action === 'vertical') {
    const x = nodes.reduce((sum, node) => sum + node.position.x, 0) / nodes.length;
    return nodes.map((node) => ({ nodeId: node.id, position: { x, y: node.position.y } }));
  }
  if (action === 'distribute') {
    const xSpan = Math.max(...nodes.map((node) => node.position.x)) - Math.min(...nodes.map((node) => node.position.x));
    const ySpan = Math.max(...nodes.map((node) => node.position.y)) - Math.min(...nodes.map((node) => node.position.y));
    const axis = xSpan >= ySpan ? 'x' as const : 'y' as const;
    const sorted = [...nodes].sort((a, b) => a.position[axis] - b.position[axis] || a.id.localeCompare(b.id));
    const start = sorted[0].position[axis];
    const end = sorted.at(-1)!.position[axis];
    return sorted.map((node, index) => ({
      nodeId: node.id,
      position: { ...node.position, [axis]: start + (end - start) * index / (sorted.length - 1) },
    }));
  }

  const byX = [...nodes].sort((a, b) =>
    a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id));
  const axisX = (byX[0].position.x + byX.at(-1)!.position.x) / 2;
  const pairCount = Math.floor(byX.length / 2);
  const byVerticalPosition = (a: typeof byX[number], b: typeof byX[number]) =>
    a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id);
  const left = byX.slice(0, pairCount).sort(byVerticalPosition);
  const right = byX.slice(byX.length - pairCount).sort(byVerticalPosition);
  const result = new Map(nodes.map((node) => [node.id, { ...node.position }]));
  for (let index = 0; index < pairCount; index += 1) {
    const leftNode = left[index];
    const rightNode = right[index];
    const halfDistance = Math.abs(rightNode.position.x - leftNode.position.x) / 2;
    const y = (leftNode.position.y + rightNode.position.y) / 2;
    result.set(leftNode.id, { x: axisX - halfDistance, y });
    result.set(rightNode.id, { x: axisX + halfDistance, y });
  }
  if (byX.length % 2 === 1) {
    const center = byX[pairCount];
    result.set(center.id, { ...center.position, x: axisX });
  }
  return nodes.map((node) => ({ nodeId: node.id, position: result.get(node.id)! }));
}
