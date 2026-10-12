import { describe, expect, it, vi } from 'vitest';
import { VectorDocument } from './document';
import { OperationManager } from './operations';
import type { Segment, VectorNode, VectorPath } from './types';

const node = (id: string, x: number, y: number): VectorNode => ({
  id,
  position: { x, y },
  constraintIds: [],
});

describe('OperationManager', () => {
  it('applies, undoes, and redoes semantic graph operations', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const networkId = document.activeNetwork.id;
    const first = node('node-a', 10, 20);
    const second = node('node-b', 90, 20);
    const path: VectorPath = { id: 'path-a', segmentIds: [], isClosed: false };
    const segment: Segment = {
      id: 'segment-a',
      startNodeId: first.id,
      endNodeId: second.id,
      type: 'line', role: 'geometry',
    };

    manager.beginTransaction('Create line');
    manager.execute({ type: 'ADD_NODE', payload: { node: first, networkId } });
    manager.execute({ type: 'ADD_NODE', payload: { node: second, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
    manager.commitTransaction();

    expect(document.nodes.size).toBe(2);
    expect(document.segments.size).toBe(1);
    expect(manager.canUndo).toBe(true);

    expect(manager.undo()).toBe(true);
    expect(document.nodes.size).toBe(0);
    expect(document.paths.size).toBe(0);
    expect(document.segments.size).toBe(0);

    expect(manager.redo()).toBe(true);
    expect(document.nodes.size).toBe(2);
    expect(document.getPath(path.id)?.segmentIds).toEqual([segment.id]);
  });

  it('hides and restores an object stroke without discarding its attributes', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const appearance = [...document.appearances.values()][0];
    const originalStroke = { ...appearance.stroke! };

    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: { appearanceId: appearance.id, updates: { stroke: { ...originalStroke, visible: false } } },
    });
    expect(document.getAppearance(appearance.id)?.stroke).toEqual({ ...originalStroke, visible: false });
    expect(manager.undo()).toBe(true);
    expect(document.getAppearance(appearance.id)?.stroke).toEqual(originalStroke);
    expect(manager.redo()).toBe(true);
    expect(document.getAppearance(appearance.id)?.stroke).toEqual({ ...originalStroke, visible: false });
  });

  it('coalesces live drag deltas into one undoable transaction', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const networkId = document.activeNetwork.id;
    const item = node('node-a', 0, 0);
    const listener = vi.fn();
    manager.subscribe(listener);
    manager.execute({ type: 'ADD_NODE', payload: { node: item, networkId } });

    manager.beginTransaction('Move node');
    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: item.id, delta: { x: 2, y: 3 } } });
    manager.execute({ type: 'MOVE_NODE', payload: { nodeId: item.id, delta: { x: 8, y: -1 } } });
    manager.commitTransaction();

    expect(document.getNode(item.id)?.position).toEqual({ x: 10, y: 2 });
    manager.undo();
    expect(document.getNode(item.id)?.position).toEqual({ x: 0, y: 0 });
    manager.redo();
    expect(document.getNode(item.id)?.position).toEqual({ x: 10, y: 2 });
    expect(listener).toHaveBeenCalled();
  });

  it('rejects malformed native arcs before the mutation boundary commits', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const networkId = document.activeNetwork.id;
    const first = node('arc-start', 0, 0);
    const second = node('arc-end', 20, 0);
    const path: VectorPath = { id: 'arc-path', segmentIds: [], isClosed: false };
    manager.beginTransaction('Arc setup');
    manager.execute({ type: 'ADD_NODE', payload: { node: first, networkId } });
    manager.execute({ type: 'ADD_NODE', payload: { node: second, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.commitTransaction();
    const listener = vi.fn();
    manager.subscribe(listener);

    const malformed: Segment[] = [
      { id: 'arc-no-center', startNodeId: first.id, endNodeId: second.id, type: 'arc', role: 'geometry', radius: 10, startAngle: 0, endAngle: Math.PI },
      { id: 'arc-bad-radius', startNodeId: first.id, endNodeId: second.id, type: 'arc', role: 'geometry', center: { x: 10, y: 0 }, radius: Number.NaN, startAngle: 0, endAngle: Math.PI },
      { id: 'arc-bad-angle', startNodeId: first.id, endNodeId: second.id, type: 'arc', role: 'geometry', center: { x: 10, y: 0 }, radius: 10, startAngle: Number.POSITIVE_INFINITY, endAngle: Math.PI },
      { id: 'line-with-arc-data', startNodeId: first.id, endNodeId: second.id, type: 'line', role: 'geometry', center: { x: 10, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI },
    ];
    for (const segment of malformed) {
      expect(() => manager.execute({
        type: 'ADD_SEGMENT',
        payload: { segment, pathId: path.id },
      })).toThrow(/native arc|cannot contain native arc geometry/i);
    }
    expect(document.segments.size).toBe(0);
    expect(document.getPath(path.id)?.segmentIds).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects malformed construction semantics before commit', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const networkId = document.activeNetwork.id;
    const first = node('guide-start', 0, 0);
    const second = node('guide-end', 20, 0);
    const path: VectorPath = { id: 'guide-path', segmentIds: [], isClosed: false };
    manager.beginTransaction('Guide setup');
    manager.execute({ type: 'ADD_NODE', payload: { node: first, networkId } });
    manager.execute({ type: 'ADD_NODE', payload: { node: second, networkId } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
    manager.commitTransaction();
    const listener = vi.fn();
    manager.subscribe(listener);

    const malformed: Segment[] = [
      {
        id: 'guide-no-extent', startNodeId: first.id, endNodeId: second.id,
        type: 'line', role: 'construction',
      },
      {
        id: 'guide-curve', startNodeId: first.id, endNodeId: second.id,
        type: 'bezier', role: 'construction', constructionExtent: 'finite',
      },
      {
        id: 'guide-width', startNodeId: first.id, endNodeId: second.id,
        type: 'line', role: 'construction', constructionExtent: 'finite', widthProfile: [],
      },
      {
        id: 'geometry-with-extent', startNodeId: first.id, endNodeId: second.id,
        type: 'line', role: 'geometry', constructionExtent: 'infinite',
      },
      {
        id: 'guide-zero-length', startNodeId: first.id, endNodeId: first.id,
        type: 'line', role: 'construction', constructionExtent: 'infinite',
      },
      {
        id: 'guide-no-role', startNodeId: first.id, endNodeId: second.id, type: 'line',
      } as Segment,
    ];
    for (const segment of malformed) {
      expect(() => manager.execute({
        type: 'ADD_SEGMENT',
        payload: { segment, pathId: path.id },
      })).toThrow(/construction|role|anchor/i);
    }
    expect(document.segments.size).toBe(0);
    expect(document.getPath(path.id)?.segmentIds).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('runs validators before mutation', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    manager.addValidator((operation) => operation.type === 'ADD_NODE' ? 'Rejected by solver' : undefined);

    expect(() => manager.execute({
      type: 'ADD_NODE',
      payload: { node: node('blocked', 0, 0), networkId: document.activeNetwork.id },
    })).toThrow('Rejected by solver');
    expect(document.nodes.size).toBe(0);
  });
});
