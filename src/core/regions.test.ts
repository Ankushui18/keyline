import { describe, expect, it, vi } from 'vitest';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import { detectRegions, detectRegionsDetailed } from './regions';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import { buildShapeBuilderResult, regionAtPoint } from '../tools/shape-builder';
import type { Point, Segment, VectorNode, VectorPath } from './types';

function addPolygon(document: VectorDocument, manager: OperationManager, points: Point[]): void {
  addLinearPath(document, manager, points, { closed: true, role: 'geometry' });
}

function addLinearPath(
  document: VectorDocument,
  manager: OperationManager,
  points: Point[],
  options: {
    closed: boolean;
    role: Segment['role'];
    constructionExtent?: Segment['constructionExtent'];
  },
): { path: VectorPath; nodes: VectorNode[]; segments: Segment[] } {
  const networkId = document.activeNetwork.id;
  const nodes: VectorNode[] = points.map((position) => ({
    id: createEntityId(), position, constraintIds: [],
  }));
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: options.closed };
  const segmentCount = options.closed ? nodes.length : nodes.length - 1;
  const segments = Array.from({ length: segmentCount }, (_, index): Segment => ({
    id: createEntityId(),
    startNodeId: nodes[index].id,
    endNodeId: nodes[(index + 1) % nodes.length].id,
    type: 'line',
    role: options.role,
    constructionExtent: options.role === 'construction' ? options.constructionExtent ?? 'finite' : undefined,
  }));
  manager.beginTransaction('Linear path');
  for (const node of nodes) manager.execute({ type: 'ADD_NODE', payload: { node, networkId } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  for (const segment of segments) {
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  }
  manager.commitTransaction();
  return { path: document.getPath(path.id)!, nodes, segments };
}

function addCircle(document: VectorDocument, manager: OperationManager, cx: number, cy: number, radius: number): void {
  const k = radius * 0.5522847498;
  const nodes: VectorNode[] = [
    { id: createEntityId(), position: { x: cx + radius, y: cy }, handleIn: { x: cx + radius, y: cy - k }, handleOut: { x: cx + radius, y: cy + k }, constraintIds: [] },
    { id: createEntityId(), position: { x: cx, y: cy + radius }, handleIn: { x: cx + k, y: cy + radius }, handleOut: { x: cx - k, y: cy + radius }, constraintIds: [] },
    { id: createEntityId(), position: { x: cx - radius, y: cy }, handleIn: { x: cx - radius, y: cy + k }, handleOut: { x: cx - radius, y: cy - k }, constraintIds: [] },
    { id: createEntityId(), position: { x: cx, y: cy - radius }, handleIn: { x: cx - k, y: cy - radius }, handleOut: { x: cx + k, y: cy - radius }, constraintIds: [] },
  ];
  const networkId = document.activeNetwork.id;
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: true };
  manager.beginTransaction('Circle');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  nodes.forEach((node, index) => manager.execute({
    type: 'ADD_SEGMENT',
    payload: {
      segment: { id: createEntityId(), startNodeId: node.id, endNodeId: nodes[(index + 1) % nodes.length].id, type: 'bezier', role: 'geometry' },
      pathId: path.id,
    },
  }));
  manager.commitTransaction();
}

describe('region detection', () => {
  it('finds a stable bounded face for a closed square', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);

    const first = detectRegions(document);
    expect(first).toHaveLength(1);
    expect(first[0].area).toBeCloseTo(10_000, 2);
    expect(first[0].boundarySegmentIds).toHaveLength(4);

    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: document.activeNetwork.nodeIds[0], delta: { x: 4, y: 2 } } });
    const moved = detectRegions(document);
    expect(moved[0].id).toBe(first[0].id);
  });

  it('ignores an infinite construction line crossing a region and preserves its stable ID when moved', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addPolygon(document, manager, [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ]);
    const original = document.regions[0];
    expect(original).toBeDefined();
    manager.execute({
      type: 'SET_REGION_FILL',
      payload: { regionId: original.id, fill: { type: 'solid', color: '#7a5cff' } },
    });

    const guide = addLinearPath(document, manager, [
      { x: 50, y: -50 }, { x: 50, y: 150 },
    ], { closed: false, role: 'construction', constructionExtent: 'infinite' });
    expect(document.regions).toHaveLength(1);
    expect(document.regions[0]).toMatchObject({
      id: original.id,
      area: original.area,
      fill: { type: 'solid', color: '#7a5cff' },
    });
    expect(document.regions[0].boundarySegmentIds).not.toContain(guide.segments[0].id);

    manager.execute({
      type: 'MOVE_NODE',
      payload: { nodeId: guide.nodes[0].id, delta: { x: 25, y: 0 } },
    });
    expect(document.regions).toHaveLength(1);
    expect(document.regions[0].id).toBe(original.id);
    expect(document.regions[0].boundarySegmentIds).toEqual(original.boundarySegmentIds);
    expect(document.regions[0].fill).toEqual({ type: 'solid', color: '#7a5cff' });
  });

  it('creates zero regions for a closed loop made only of finite construction lines', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addLinearPath(document, manager, [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ], { closed: true, role: 'construction', constructionExtent: 'finite' });

    expect(detectRegions(document)).toEqual([]);
    expect(document.regions).toEqual([]);
    // Paint and Shape Builder share regionAtPoint; neither can target this loop.
    expect(regionAtPoint(document, { x: 50, y: 50 })).toBeNull();
    expect(() => buildShapeBuilderResult(document, [], [], 'construction-loop', false))
      .toThrow('Shape Builder selection contains a region that is no longer available.');
  });

  it('associates an oppositely wound nested ring as a hole while retaining its inner face', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addPolygon(document, manager, [
      { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 },
    ]);
    // Counter-wound relative to the outer ring.
    addPolygon(document, manager, [
      { x: 50, y: 50 }, { x: 50, y: 150 }, { x: 150, y: 150 }, { x: 150, y: 50 },
    ]);

    expect(document.regions).toHaveLength(2);
    const compound = document.regions.find((region) => region.innerLoops.length === 1)!;
    const inner = document.regions.find((region) => region.innerLoops.length === 0)!;
    expect(compound).toBeDefined();
    expect(compound.fillRule).toBe('nonzero');
    expect(compound.outerLoop.signedArea).toBeGreaterThan(0);
    expect(compound.innerLoops[0].signedArea).toBeLessThan(0);
    expect(compound.boundaryEdges).toHaveLength(8);
    expect(compound.boundarySegmentIds).toHaveLength(8);
    expect(compound.area).toBeCloseTo(30_000, 4);
    expect(inner.area).toBeCloseTo(10_000, 4);
    expect(regionAtPoint(document, { x: 25, y: 25 })?.id).toBe(compound.id);
    expect(regionAtPoint(document, { x: 100, y: 100 })?.id).toBe(inner.id);

    manager.execute({
      type: 'SET_REGION_FILL_RULE',
      payload: { regionId: compound.id, fillRule: 'evenodd' },
    });
    expect(document.regions.find((region) => region.id === compound.id)?.fillRule).toBe('evenodd');
    manager.undo();
    expect(document.regions.find((region) => region.id === compound.id)?.fillRule).toBe('nonzero');
    manager.redo();
    expect(document.regions.find((region) => region.id === compound.id)?.fillRule).toBe('evenodd');
    const restored = new VectorDocument(document.toSnapshot());
    new OperationManager(restored);
    expect(restored.regions.find((region) => region.id === compound.id)).toMatchObject({
      fillRule: 'evenodd',
      innerLoops: [{ boundarySegmentIds: expect.any(Array) }],
      area: 30_000,
    });
  });

  it('reports deterministic self-intersection and ambiguous-overlap diagnostics', () => {
    const selfIntersecting = VectorDocument.createEmpty();
    const selfManager = new OperationManager(selfIntersecting);
    addPolygon(selfIntersecting, selfManager, [
      { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 },
    ]);
    const selfResult = detectRegionsDetailed(selfIntersecting);
    expect(selfResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'self-intersection', severity: 'warning' }),
    ]));

    const overlapping = VectorDocument.createEmpty();
    const overlapManager = new OperationManager(overlapping);
    const diagnosticListener = vi.fn();
    overlapManager.setRegionDiagnosticsListener(diagnosticListener);
    addLinearPath(overlapping, overlapManager, [{ x: 0, y: 0 }, { x: 100, y: 0 }], {
      closed: false, role: 'geometry',
    });
    addLinearPath(overlapping, overlapManager, [{ x: 25, y: 0 }, { x: 75, y: 0 }], {
      closed: false, role: 'geometry',
    });
    const first = detectRegionsDetailed(overlapping).diagnostics;
    const second = detectRegionsDetailed(overlapping).diagnostics;
    expect(first).toEqual(second);
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ambiguous-overlap',
        severity: 'error',
        message: 'Ambiguous overlapping boundaries cannot define a stable Smart Fill region.',
      }),
    ]));
    expect(diagnosticListener).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ code: 'ambiguous-overlap' }),
    ]));
  });

  it('enforces the Gate C solid-only FillStyle decision at the mutation boundary', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addPolygon(document, manager, [
      { x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 },
    ]);
    const region = document.regions[0];
    expect(() => manager.execute({
      type: 'SET_REGION_FILL',
      payload: { regionId: region.id, fill: { type: 'gradient', color: '#123456' } },
    } as never)).toThrow('Smart Fill supports a solid color only in Gate C.');
    expect(document.regions[0].fill).toBeUndefined();
    expect(() => manager.execute({
      type: 'SET_REGION_FILL_RULE',
      payload: { regionId: region.id, fillRule: 'winding' },
    } as never)).toThrow('requires a nonzero or evenodd fill rule');
    expect(document.regions[0].fillRule).toBe('nonzero');
  });

  it('finds three atomic faces formed by two overlapping squares', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addPolygon(document, manager, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    addPolygon(document, manager, [{ x: 50, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 100 }, { x: 50, y: 100 }]);

    const regions = detectRegions(document);
    expect(regions).toHaveLength(3);
    expect(regions.map((region) => Math.round(region.area ?? 0)).sort((a, b) => a - b)).toEqual([5000, 5000, 5000]);
  });

  it('detects the three faces formed by overlapping cubic circles', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    addCircle(document, manager, 0, 0, 50);
    addCircle(document, manager, 60, 0, 50);
    expect(document.regions).toHaveLength(3);
    expect(document.regions.every((region) => (region.outline?.length ?? 0) > 8)).toBe(true);
  });

  it('keeps identical local geometry in separate object networks paintable', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first = preparePrimitiveObject(document, 'rectangle', { x: 20, y: 30 }, { x: 120, y: 110 });
    expect(first).not.toBeNull();
    first!.operations.forEach((operation) => manager.execute(operation));
    const second = preparePrimitiveObject(document, 'rectangle', { x: 240, y: 160 }, { x: 340, y: 240 });
    expect(second).not.toBeNull();
    second!.operations.forEach((operation) => manager.execute(operation));

    expect(document.regions).toHaveLength(2);
    const owners = document.regions.map((region) =>
      document.getObjectForSegment(region.boundarySegmentIds[0])?.id,
    );
    expect(new Set(owners)).toEqual(new Set([first!.objectId, second!.objectId]));
  });
});
