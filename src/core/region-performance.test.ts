import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { detectRegionsDetailed } from './regions';
import type { DocumentSnapshot, Segment, VectorNode, VectorPath } from './types';

function largeSeparatedNetwork(squareCount = 128): VectorDocument {
  const networkId = 'performance-network';
  const nodes: Array<[string, VectorNode]> = [];
  const segments: Array<[string, Segment]> = [];
  const paths: Array<[string, VectorPath]> = [];
  const pathIds: string[] = [];
  for (let square = 0; square < squareCount; square += 1) {
    const column = square % 16;
    const row = Math.floor(square / 16);
    const originX = column * 30;
    const originY = row * 30;
    const nodeIds = Array.from({ length: 4 }, (_, index) => `n-${square}-${index}`);
    const positions = [
      { x: originX, y: originY }, { x: originX + 12, y: originY },
      { x: originX + 12, y: originY + 12 }, { x: originX, y: originY + 12 },
    ];
    nodeIds.forEach((id, index) => nodes.push([id, { id, position: positions[index], constraintIds: [] }]));
    const segmentIds = Array.from({ length: 4 }, (_, index) => `s-${square}-${index}`);
    segmentIds.forEach((id, index) => segments.push([id, {
      id,
      startNodeId: nodeIds[index],
      endNodeId: nodeIds[(index + 1) % 4],
      type: 'line',
      role: 'geometry',
    }]));
    const pathId = `p-${square}`;
    paths.push([pathId, { id: pathId, segmentIds, isClosed: true }]);
    pathIds.push(pathId);
  }
  const snapshot: DocumentSnapshot = {
    version: 6,
    id: 'performance-document',
    networks: [{ id: networkId, nodeIds: nodes.map(([id]) => id), pathIds }],
    nodes,
    segments,
    paths,
    regions: [],
    variables: [],
  };
  return new VectorDocument(snapshot);
}

describe('region broad-phase performance', () => {
  it('detects 128 disjoint faces from 512 segments within 50 ms', () => {
    const document = largeSeparatedNetwork();
    const started = performance.now();
    const result = detectRegionsDetailed(document);
    const elapsed = performance.now() - started;

    expect(result.regions).toHaveLength(128);
    expect(result.stats.sourceSegments).toBe(512);
    expect(result.stats.theoreticalPairs).toBe(130_816);
    expect(result.stats.candidatePairs).toBeLessThan(2_000);
    expect(result.stats.exactIntersectionTests).toBeLessThan(2_000);
    expect(elapsed).toBeLessThan(50);
  });
});
