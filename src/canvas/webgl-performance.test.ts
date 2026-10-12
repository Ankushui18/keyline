import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { concreteDocumentSegments } from '../export/svg-export';
import {
  prepareWebGLConstructionFrame,
  prepareWebGLConstructionIndex,
} from './webgl-renderer';

describe('WebGL large-scene preparation', () => {
  it('materializes 10,000 graph segments within the renderer preparation budget', () => {
    const snapshot = VectorDocument.createEmpty().toSnapshot();
    const network = snapshot.networks[0];
    const pathId = 'performance-path';
    const segmentIds: string[] = [];
    network.nodeIds = [];
    network.pathIds = [pathId];
    snapshot.nodes = [];
    snapshot.segments = [];
    for (let index = 0; index <= 10_000; index += 1) {
      const nodeId = `performance-node-${index}`;
      network.nodeIds.push(nodeId);
      snapshot.nodes.push([nodeId, {
        id: nodeId,
        position: { x: index % 500, y: Math.floor(index / 500) * 8 },
        constraintIds: [],
      }]);
      if (index > 0) {
        const segmentId = `performance-segment-${index}`;
        segmentIds.push(segmentId);
        snapshot.segments.push([segmentId, {
          id: segmentId,
          startNodeId: `performance-node-${index - 1}`,
          endNodeId: nodeId,
          type: 'line', role: 'geometry',
        }]);
      }
    }
    snapshot.paths = [[pathId, { id: pathId, segmentIds, isClosed: false }]];
    const document = new VectorDocument(snapshot);
    const started = performance.now();
    const concrete = concreteDocumentSegments(document);
    const elapsed = performance.now() - started;
    expect(concrete).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(1200);
  });

  it('prepares viewport-clipped infinite construction lines across 120 manipulated frames without invalid GPU data', () => {
    const snapshot = VectorDocument.createEmpty().toSnapshot();
    const network = snapshot.networks[0];
    const pathId = 'construction-performance-path';
    const segmentIds: string[] = [];
    network.nodeIds = [];
    network.pathIds = [pathId];
    snapshot.nodes = [];
    snapshot.segments = [];
    for (let index = 0; index < 12; index += 1) {
      const startId = `construction-start-${index}`;
      const endId = `construction-end-${index}`;
      const segmentId = `construction-infinite-${index}`;
      network.nodeIds.push(startId, endId);
      snapshot.nodes.push(
        [startId, { id: startId, position: { x: -10, y: -55 + index * 10 }, constraintIds: [] }],
        [endId, { id: endId, position: { x: 10, y: -55 + index * 10 }, constraintIds: [] }],
      );
      snapshot.segments.push([segmentId, {
        id: segmentId,
        startNodeId: startId,
        endNodeId: endId,
        type: 'line',
        role: 'construction',
        constructionExtent: 'infinite',
      }]);
      segmentIds.push(segmentId);
    }
    snapshot.paths = [[pathId, { id: pathId, segmentIds, isClosed: false }]];
    const document = new VectorDocument(snapshot);
    const indexed = prepareWebGLConstructionIndex(document);
    expect(indexed.finite).toEqual([]);
    expect(indexed.infiniteSegmentIds).toHaveLength(12);

    const started = performance.now();
    let vertexCount = 0;
    let planCount = 0;
    let allFinite = true;
    for (let frame = 0; frame < 120; frame += 1) {
      const offset = Math.sin(frame / 12) * 90;
      const scale = 0.75 + (frame % 30) / 60;
      const plans = prepareWebGLConstructionFrame(
        document,
        [],
        indexed.infiniteSegmentIds,
        { minX: -560 + offset, minY: -110, maxX: 560 + offset, maxY: 110 },
        scale,
      );
      planCount += plans.length;
      for (const plan of plans) {
        allFinite = allFinite && plan.vertexData.every(Number.isFinite);
        vertexCount += plan.vertexData.length / 6;
      }
    }
    const elapsed = performance.now() - started;
    expect(planCount).toBe(12 * 120);
    expect(allFinite).toBe(true);
    expect(vertexCount).toBeGreaterThan(100_000);
    // 120 viewport/zoom frames retain an average renderer-preparation budget below 10 ms.
    expect(elapsed).toBeLessThan(1200);
  });
});
