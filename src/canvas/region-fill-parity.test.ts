import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { EntityId, Point, Segment, VectorNode, VectorPath } from '../core/types';
import { exportDocumentToSvg } from '../export/svg-export';
import { regionFillVertexData } from './webgl-renderer';

function addPolygon(document: VectorDocument, manager: OperationManager, points: Point[]): EntityId {
  const networkId = document.activeNetwork.id;
  const nodes = points.map((position): VectorNode => ({ id: createEntityId(), position, constraintIds: [] }));
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: true };
  const segments = nodes.map((node, index): Segment => ({
    id: createEntityId(), startNodeId: node.id, endNodeId: nodes[(index + 1) % nodes.length].id,
    type: 'line', role: 'geometry',
  }));
  manager.beginTransaction('Compound fixture');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  segments.forEach((segment) => manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } }));
  manager.commitTransaction();
  return path.id;
}

function vertexArea(data: number[]): number {
  let area = 0;
  for (let offset = 0; offset < data.length; offset += 18) {
    const a = { x: data[offset], y: data[offset + 1] };
    const b = { x: data[offset + 6], y: data[offset + 7] };
    const c = { x: data[offset + 12], y: data[offset + 13] };
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  return area;
}

describe('compound Smart Fill renderer parity', () => {
  it('preserves RGB and embedded hex alpha in the shared WebGL paint vertices', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }]);
    const regionId = document.regions[0].id;
    for (const [color, alpha] of [['#12345680', 128 / 255], ['#12345600', 0], ['#123456', 1]] as const) {
      manager.execute({ type: 'SET_REGION_FILL', payload: { regionId, fill: { type: 'solid', color } } });
      const vertices = regionFillVertexData(document, document.regions.find((region) => region.id === regionId)!);
      expect(vertices.length).toBeGreaterThan(0);
      for (let offset = 0; offset < vertices.length; offset += 6) {
        expect(vertices[offset + 2]).toBeCloseTo(0x12 / 255);
        expect(vertices[offset + 3]).toBeCloseTo(0x34 / 255);
        expect(vertices[offset + 4]).toBeCloseTo(0x56 / 255);
        expect(vertices[offset + 5]).toBeCloseTo(alpha);
      }
    }
  });

  it('uses one loop/rule model for WebGL tessellation and SVG export', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const outerPathId = addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }]);
    const innerPathId = addPolygon(document, manager, [{ x: 50, y: 50 }, { x: 50, y: 150 }, { x: 150, y: 150 }, { x: 150, y: 50 }]);
    const compound = document.regions.find((region) => region.innerLoops.length === 1)!;
    manager.execute({ type: 'SET_REGION_FILL', payload: {
      regionId: compound.id, fill: { type: 'solid', color: '#336699' },
    } });
    manager.execute({ type: 'SET_REGION_FILL_RULE', payload: { regionId: compound.id, fillRule: 'evenodd' } });
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group: {
      id: createEntityId(), sourcePathIds: [outerPathId, innerPathId],
      transform: { type: 'radial', center: { x: 300, y: 100 }, count: 2, sweepAngle: 360 },
    } } });
    const current = document.regions.find((region) => region.id === compound.id)!;

    const vertices = regionFillVertexData(document, current);
    expect(vertices.length).toBeGreaterThan(0);
    expect(vertices.length % 18).toBe(0);
    expect(vertices.every(Number.isFinite)).toBe(true);
    expect(vertexArea(vertices)).toBeCloseTo(60_000, 6);

    const svg = exportDocumentToSvg(document, { padding: 0, includeMetadata: true });
    expect(svg).toContain('fill="#336699" fill-rule="evenodd"');
    expect(svg.match(new RegExp(`data-region-id="${compound.id}"`, 'g'))).toHaveLength(2);
    expect(svg).toContain('data-parametric-instance="1"');
  });
});
