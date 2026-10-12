import { describe, expect, it, vi } from 'vitest';
import { validateFillet } from '../tools/fillet-tool';
import { preparePathOffset } from '../tools/offset-tool';
import { prepareReversePath } from '../tools/path-commands';
import { prepareCutPaths, prepareSplitSegment } from '../tools/cut-tool';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import {
  OperationManager,
  type OperationDescriptor,
  type SegmentRoleUpdate,
} from './operations';
import type { Constraint, Point, Segment, VectorNode, VectorPath } from './types';

function addPath(
  document: VectorDocument,
  manager: OperationManager,
  points: Point[],
  options: { closed?: boolean; role?: Segment['role']; extent?: Segment['constructionExtent'] } = {},
): { path: VectorPath; nodes: VectorNode[]; segments: Segment[] } {
  const networkId = document.activeNetwork.id;
  const nodes: VectorNode[] = points.map((position) => ({
    id: createEntityId(), position: { ...position }, constraintIds: [],
  }));
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: options.closed ?? false };
  const count = options.closed ? nodes.length : nodes.length - 1;
  const segments = Array.from({ length: count }, (_, index): Segment => ({
    id: createEntityId(),
    startNodeId: nodes[index].id,
    endNodeId: nodes[(index + 1) % nodes.length].id,
    type: 'line',
    role: options.role ?? 'geometry',
    constructionExtent: options.role === 'construction' ? options.extent ?? 'finite' : undefined,
  }));
  manager.beginTransaction('Path fixture');
  nodes.forEach((node) => manager.execute({ type: 'ADD_NODE', payload: { node, networkId } }));
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  segments.forEach((segment) => manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } }));
  manager.commitTransaction();
  return { path: document.getPath(path.id)!, nodes, segments };
}

function roleUpdate(segment: Segment, constructionExtent: 'finite' | 'infinite' = 'finite'): SegmentRoleUpdate {
  return { segmentId: segment.id, role: 'construction', constructionExtent };
}

function descriptor(type: OperationDescriptor['type'], payload: unknown): OperationDescriptor {
  return { id: createEntityId(), timestamp: Date.now(), type, payload };
}

describe('Gate B2 construction operations and graph invariants', () => {
  it('sets multiple segment roles atomically and supports Undo, Redo, and rollback', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 20 },
    ]);

    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: fixture.segments.map((segment) => roleUpdate(segment, 'finite')) },
    });
    expect(fixture.segments.map((segment) => document.getSegment(segment.id))).toEqual(
      fixture.segments.map((segment) => expect.objectContaining({
        id: segment.id, role: 'construction', constructionExtent: 'finite',
      })),
    );

    expect(manager.undo()).toBe(true);
    expect(fixture.segments.every((segment) => document.getSegment(segment.id)?.role === 'geometry')).toBe(true);
    expect(manager.redo()).toBe(true);
    expect(fixture.segments.every((segment) => document.getSegment(segment.id)?.role === 'construction')).toBe(true);

    manager.beginTransaction('Temporary extent update');
    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [roleUpdate(fixture.segments[0], 'infinite')] },
    });
    expect(document.getSegment(fixture.segments[0].id)?.constructionExtent).toBe('infinite');
    manager.rollbackTransaction();
    expect(document.getSegment(fixture.segments[0].id)).toMatchObject({
      role: 'construction', constructionExtent: 'finite',
    });
  });

  it('restores a painted region and its fill after construction conversion is undone', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ], { closed: true });
    const region = document.regions[0];
    expect(region).toBeDefined();
    manager.execute({
      type: 'SET_REGION_FILL',
      payload: { regionId: region.id, fill: { type: 'solid', color: '#c75b32' } },
    });

    const conversion = manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [roleUpdate(fixture.segments[0])] },
    });
    expect(conversion.inverse).toMatchObject({
      type: 'BATCH',
      payload: {
        operations: [
          {
            type: 'SET_SEGMENT_ROLES',
            payload: { segments: [{ segmentId: fixture.segments[0].id, role: 'geometry' }] },
          },
          {
            type: 'SET_REGION_FILL',
            payload: { regionId: region.id, fill: { type: 'solid', color: '#c75b32' } },
          },
        ],
      },
    });
    expect(JSON.parse(JSON.stringify(conversion.inverse))).toEqual(conversion.inverse);
    expect(document.getSegment(fixture.segments[0].id)).toMatchObject({
      role: 'construction', constructionExtent: 'finite',
    });
    expect(document.regions).toHaveLength(0);

    expect(manager.undo()).toBe(true);
    expect(document.regions).toHaveLength(1);
    expect(document.regions[0].id).toBe(region.id);
    expect(document.regions[0].fill).toEqual({ type: 'solid', color: '#c75b32' });
    expect(document.getSegment(fixture.segments[0].id)).toMatchObject({
      role: 'geometry', constructionExtent: undefined,
    });

    expect(manager.redo()).toBe(true);
    expect(document.getSegment(fixture.segments[0].id)).toMatchObject({
      role: 'construction', constructionExtent: 'finite',
    });
    expect(document.regions).toHaveLength(0);
  });

  it('recursively rejects an invalid nested role batch before any mutation or event', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 },
    ]);
    const listener = vi.fn();
    manager.subscribe(listener);
    const valid = descriptor('SET_SEGMENT_ROLES', {
      segments: [roleUpdate(fixture.segments[0])],
    });
    const invalid = descriptor('SET_SEGMENT_ROLES', {
      segments: [{ segmentId: fixture.segments[1].id, role: 'construction' }],
    });
    const nested = descriptor('BATCH', { label: 'Nested invalid role', operations: [invalid] });

    expect(() => manager.execute({
      type: 'BATCH',
      payload: { label: 'Atomic role batch', operations: [valid, nested] },
    })).toThrow('requires a finite or infinite extent');
    expect(fixture.segments.every((segment) => document.getSegment(segment.id)?.role === 'geometry')).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('preserves finite construction semantics through split and reverse', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 100, y: 0 },
    ], { role: 'construction', extent: 'finite' });
    const original = fixture.segments[0];
    const split = prepareSplitSegment(document, original.id, 0.4)!;
    expect(split.newSegment1).toMatchObject({ role: 'construction', constructionExtent: 'finite' });
    expect(split.newSegment2).toMatchObject({ role: 'construction', constructionExtent: 'finite' });
    manager.execute({ type: 'SPLIT_SEGMENT', payload: split });
    expect(document.getSegment(split.newSegment1Id)).toMatchObject({
      role: 'construction', constructionExtent: 'finite',
    });
    expect(document.getSegment(split.newSegment2Id)).toMatchObject({
      role: 'construction', constructionExtent: 'finite',
    });

    const reverse = prepareReversePath(document, fixture.path.id)!;
    manager.execute({ type: 'APPLY_GRAPH_PATCH', payload: reverse });
    expect(document.getPath(fixture.path.id)?.segmentIds.every((segmentId) => {
      const segment = document.getSegment(segmentId);
      return segment?.role === 'construction' && segment.constructionExtent === 'finite';
    })).toBe(true);

    manager.undo();
    manager.undo();
    expect(document.getSegment(original.id)).toMatchObject({
      role: 'construction', constructionExtent: 'finite',
    });
  });

  it('preserves finite construction semantics through a Cut operation', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 100, y: 0 },
    ], { role: 'construction', extent: 'finite' });
    const cut = prepareCutPaths(document, { x: 40, y: -20 }, { x: 40, y: 20 })!;
    expect(cut.splits).toHaveLength(1);
    expect(cut.newSegments.every((segment) =>
      segment.role === 'construction' && segment.constructionExtent === 'finite')).toBe(true);
    manager.execute({ type: 'CUT_PATHS', payload: cut });
    expect(document.getPath(fixture.path.id)?.segmentIds).toHaveLength(2);
    expect(cut.newSegments.every((segment) => document.getSegment(segment.id)?.role === 'construction')).toBe(true);
    manager.undo();
    expect(document.getSegment(fixture.segments[0].id)).toMatchObject({
      role: 'construction', constructionExtent: 'finite',
    });
  });

  it('rejects infinite splitting at tool and operation boundaries without mutation', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 100, y: 0 },
    ], { role: 'construction', extent: 'infinite' });
    const original = fixture.segments[0];
    const listener = vi.fn();
    manager.subscribe(listener);
    expect(() => prepareSplitSegment(document, original.id, 0.5)).toThrow(
      'Infinite construction lines cannot be split.',
    );

    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [{ segmentId: original.id, role: 'construction', constructionExtent: 'finite' }] },
    });
    const finiteSplit = prepareSplitSegment(document, original.id, 0.5)!;
    manager.undo();
    listener.mockClear();
    const forged = {
      ...finiteSplit,
      originalSegment: { ...finiteSplit.originalSegment, constructionExtent: 'infinite' as const },
      newSegment1: { ...finiteSplit.newSegment1, constructionExtent: 'infinite' as const },
      newSegment2: { ...finiteSplit.newSegment2, constructionExtent: 'infinite' as const },
    };
    expect(() => manager.execute({ type: 'SPLIT_SEGMENT', payload: forged })).toThrow(
      'Infinite construction lines cannot be split.',
    );
    expect(document.getSegment(original.id)).toBeDefined();
    expect(document.nodes.size).toBe(2);
    expect(document.segments.size).toBe(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects Bend, Fillet, Variable Width, Offset, and Parametric Groups for construction', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 },
    ], { role: 'construction', extent: 'finite' });
    const first = fixture.segments[0];
    const corner = fixture.nodes[1];
    const listener = vi.fn();
    manager.subscribe(listener);

    expect(() => manager.execute({
      type: 'CONVERT_TO_BEZIER',
      payload: {
        segmentId: first.id,
        startHandleOut: { x: 20, y: 10 },
        endHandleIn: { x: 40, y: -10 },
      },
    })).toThrow('Bend is unavailable for construction segments.');
    expect(() => manager.execute({
      type: 'SET_SEGMENT_WIDTH_PROFILE',
      payload: { segmentId: first.id, widthProfile: [{ id: createEntityId(), t: 0.5, width: 12 }] },
    })).toThrow('Variable Width is unavailable for construction segments.');
    expect(() => preparePathOffset(document, fixture.path.id, 12)).toThrow(
      'Offset is unavailable for construction segments.',
    );
    const fillet = validateFillet(document, corner.id, 10);
    expect(fillet).toEqual({ valid: false, message: 'Fillet is unavailable for construction segments.' });
    expect(() => manager.execute({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: {
        group: {
          id: createEntityId(),
          sourcePathIds: [fixture.path.id],
          transform: { type: 'mirror', axis: 'x', origin: { x: 30, y: 30 } },
        },
      },
    })).toThrow('Construction paths cannot be used as Parametric Group sources.');

    expect(document.getSegment(first.id)).toMatchObject({
      type: 'line', role: 'construction', constructionExtent: 'finite', widthProfile: undefined,
    });
    expect(document.parametricGroups.size).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects converting an existing Parametric Group source path to construction', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [{ x: 0, y: 0 }, { x: 80, y: 0 }]);
    manager.execute({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: {
        group: {
          id: 'group-source',
          sourcePathIds: [fixture.path.id],
          transform: { type: 'mirror', axis: 'y', origin: { x: 40, y: 0 } },
        },
      },
    });
    const listener = vi.fn();
    manager.subscribe(listener);

    expect(() => manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [roleUpdate(fixture.segments[0])] },
    })).toThrow('Construction paths cannot be used as Parametric Group sources.');
    expect(document.getSegment(fixture.segments[0].id)?.role).toBe('geometry');
    expect(listener).not.toHaveBeenCalled();
  });

  it('rolls back a role change when a later topology mutation violates a hard constraint', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const fixture = addPath(document, manager, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const segment = fixture.segments[0];
    const constraint: Constraint = {
      id: createEntityId(),
      type: 'horizontal',
      priority: 'hard',
      targetIds: [segment.id],
      tolerance: 1e-6,
    };
    manager.execute({ type: 'ADD_CONSTRAINT', payload: { constraint } });
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.beginTransaction('Role and constrained split');
    manager.execute({
      type: 'SET_SEGMENT_ROLES',
      payload: { segments: [roleUpdate(segment)] },
    });
    const split = prepareSplitSegment(document, segment.id, 0.5)!;
    expect(() => manager.execute({ type: 'SPLIT_SEGMENT', payload: split })).toThrow(/missing geometry|no longer exists|references geometry/i);
    manager.rollbackTransaction();

    expect(document.getSegment(segment.id)).toMatchObject({
      role: 'geometry', constructionExtent: undefined,
    });
    expect(document.getPath(fixture.path.id)?.segmentIds).toEqual([segment.id]);
    expect(document.nodes.size).toBe(2);
    expect(document.constraints.has(constraint.id)).toBe(true);
    expect(listener.mock.calls.some(([event]) => event.committed === true)).toBe(false);
  });
});
