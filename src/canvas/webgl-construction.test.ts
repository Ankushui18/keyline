import { describe, expect, it } from 'vitest';
import {
  CONSTRUCTION_VISUAL_STYLE,
  projectPointToConstructionLine,
  constructionLineGeometry,
  type DocumentBounds,
} from '../core/construction-geometry';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Segment, VectorNode, VectorPath } from '../core/types';
import { hitTest } from '../tools/select-tool';
import { canvasConstructionStrokePlan } from './renderer';
import {
  prepareWebGLConstructionIndex,
  webGLConstructionStrokePlan,
} from './webgl-renderer';

function addConstructionLine(
  document: VectorDocument,
  manager: OperationManager,
  extent: 'finite' | 'infinite',
  startPosition: { x: number; y: number },
  endPosition: { x: number; y: number },
): Segment {
  const networkId = document.activeNetwork.id;
  const nodes: VectorNode[] = [
    { id: createEntityId(), position: startPosition, constraintIds: [] },
    { id: createEntityId(), position: endPosition, constraintIds: [] },
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
  manager.beginTransaction('WebGL construction fixture');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return segment;
}

function expectFiniteBounds(bounds: DocumentBounds): void {
  expect([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)).toBe(true);
  expect(bounds.minX).toBeLessThanOrEqual(bounds.maxX);
  expect(bounds.minY).toBeLessThanOrEqual(bounds.maxY);
}

describe('WebGL construction rendering', () => {
  it('indexes finite construction bounds and keeps infinite lines out of every segment index entry', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const finite = addConstructionLine(document, manager, 'finite', { x: -8, y: 2 }, { x: 14, y: 7 });
    const infinite = addConstructionLine(document, manager, 'infinite', { x: -1, y: 20 }, { x: 1, y: 20 });
    const object = document.getObjectForSegment(finite.id)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: object.id,
        updates: { transform: { x: 40, y: -10, rotation: 28, scaleX: 2.5, scaleY: 0.6 } },
      },
    });

    const prepared = prepareWebGLConstructionIndex(document);
    expect(prepared.finite.map((entry) => entry.segmentId)).toEqual([finite.id]);
    expect(prepared.infiniteSegmentIds).toEqual([infinite.id]);
    expect(prepared.finite.some((entry) => entry.segmentId === infinite.id)).toBe(false);
    prepared.finite.forEach((entry) => expectFiniteBounds(entry.bounds));

    const finiteLine = constructionLineGeometry(document, finite.id)!;
    expect(prepared.finite[0].bounds).toEqual({
      minX: Math.min(finiteLine.start.x, finiteLine.end.x),
      minY: Math.min(finiteLine.start.y, finiteLine.end.y),
      maxX: Math.max(finiteLine.start.x, finiteLine.end.x),
      maxY: Math.max(finiteLine.start.y, finiteLine.end.y),
    });
  });

  it('matches Canvas spans, hit targets, graphite style, and dash output for finite and infinite lines', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const finite = addConstructionLine(document, manager, 'finite', { x: -12, y: -6 }, { x: 16, y: 8 });
    const infinite = addConstructionLine(document, manager, 'infinite', { x: 0, y: 12 }, { x: 20, y: 12 });
    const viewportBounds = { minX: -50, minY: -30, maxX: 70, maxY: 45 };

    for (const segment of [finite, infinite]) {
      const canvas = canvasConstructionStrokePlan(document, segment.id, viewportBounds)!;
      const webgl = webGLConstructionStrokePlan(document, segment.id, viewportBounds, 2)!;
      expect({
        segmentId: webgl.segmentId,
        extent: webgl.extent,
        start: webgl.start,
        end: webgl.end,
        bounds: webgl.bounds,
        style: webgl.style,
      }).toEqual(canvas);
      expect(webgl.style).toBe(CONSTRUCTION_VISUAL_STYLE.base);
      expect(webgl.vertexData.length).toBeGreaterThan(0);
      expect(webgl.vertexData.length % 6).toBe(0);
      expect(webgl.vertexData.every(Number.isFinite)).toBe(true);
      for (let index = 0; index < webgl.vertexData.length; index += 6) {
        expect(webgl.vertexData[index + 2]).toBeCloseTo(0x77 / 255);
        expect(webgl.vertexData[index + 3]).toBeCloseTo(0x77 / 255);
        expect(webgl.vertexData[index + 4]).toBeCloseTo(0x77 / 255);
        expect(webgl.vertexData[index + 5]).toBeCloseTo(0.82);
      }
    }

    const canvasInfinite = canvasConstructionStrokePlan(document, infinite.id, viewportBounds)!;
    expect(canvasInfinite.start).toEqual({ x: -50, y: 12 });
    expect(canvasInfinite.end).toEqual({ x: 70, y: 12 });
    const hit = hitTest(document, { x: 60, y: 13 }, 2);
    expect(hit).toMatchObject({ kind: 'segment', id: canvasInfinite.segmentId });
    const line = constructionLineGeometry(document, infinite.id)!;
    expect(projectPointToConstructionLine(line, { x: 60, y: 13 }).point).toEqual({ x: 60, y: 12 });

    expect(CONSTRUCTION_VISUAL_STYLE.selected).toMatchObject({
      color: '#ffffff', haloColor: '#ffffff', widthPx: 1.75, haloWidthPx: 7,
    });
    expect(CONSTRUCTION_VISUAL_STYLE.hover).toMatchObject({
      color: '#f2b968', haloColor: '#f0b35b', widthPx: 1.75, haloWidthPx: 7,
    });
  });

  it('clips each infinite frame to finite viewport coordinates, including transformed lines', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const infinite = addConstructionLine(document, manager, 'infinite', { x: 0, y: 0 }, { x: 10, y: 0 });
    const object = document.getObjectForSegment(infinite.id)!;
    manager.execute({
      type: 'UPDATE_OBJECT',
      payload: {
        objectId: object.id,
        updates: { transform: { x: 100, y: 20, rotation: 90, scaleX: 3, scaleY: 0.5 } },
      },
    });
    const bounds = { minX: 70, minY: -40, maxX: 130, maxY: 160 };
    const plan = webGLConstructionStrokePlan(document, infinite.id, bounds, 1.5)!;
    expect(plan.start.x).toBeCloseTo(100);
    expect(plan.start.y).toBeCloseTo(-40);
    expect(plan.end.x).toBeCloseTo(100);
    expect(plan.end.y).toBeCloseTo(160);
    expectFiniteBounds(plan.bounds);
    expect(plan.vertexData.every(Number.isFinite)).toBe(true);
  });
});
