import { describe, expect, it } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Segment, VectorNode, VectorPath } from '../core/types';
import { addWidthPoint, sampleWidthProfile } from './width-tool';

describe('variable-width polish', () => {
  it('smoothly interpolates width while honoring explicit endpoint points', () => {
    const profile = [{ id: 'middle', t: 0.5, width: 9 }];
    expect(sampleWidthProfile(profile, 0, 1)).toBe(1);
    expect(sampleWidthProfile(profile, 0.125, 1)).toBeCloseTo(2.25, 8);
    expect(sampleWidthProfile(profile, 0.5, 1)).toBe(9);
    expect(sampleWidthProfile([{ id: 'start', t: 0, width: 7 }], 0, 1)).toBe(7);
  });

  it('inserts subsequent width points at the existing visual width', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const start: VectorNode = { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] };
    const end: VectorNode = { id: createEntityId(), position: { x: 100, y: 0 }, constraintIds: [] };
    const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: false };
    const segment: Segment = {
      id: createEntityId(), startNodeId: start.id, endNodeId: end.id, type: 'line', role: 'geometry',
      widthProfile: [{ id: createEntityId(), t: 0.5, width: 9 }],
    };
    manager.execute({ type: 'ADD_NODE', payload: { node: start, networkId: document.activeNetwork.id } });
    manager.execute({ type: 'ADD_NODE', payload: { node: end, networkId: document.activeNetwork.id } });
    manager.execute({ type: 'ADD_PATH', payload: { path, networkId: document.activeNetwork.id } });
    manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
    const inserted = addWidthPoint(document, segment, { x: 25, y: 2 });
    expect(inserted?.t).toBeCloseTo(0.25, 6);
    expect(inserted?.width).toBeCloseTo(sampleWidthProfile(segment.widthProfile, 0.25), 6);
  });
});
