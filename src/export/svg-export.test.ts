import { describe, expect, it } from 'vitest';
import { prepareCreateIconArtboard } from '../core/artboard-operations';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Segment, VectorNode, VectorPath } from '../core/types';
import { exportDocumentToSvg } from './svg-export';

function addPath(document: VectorDocument, manager: OperationManager, nodes: VectorNode[], segments: Segment[], closed = false) {
  const path: VectorPath = { id: createEntityId(), segmentIds: [], isClosed: closed };
  const networkId = document.activeNetwork.id;
  manager.beginTransaction('Fixture path');
  for (const node of nodes) manager.execute({ type: 'ADD_NODE', payload: { node, networkId } });
  manager.execute({ type: 'ADD_PATH', payload: { path, networkId } });
  for (const segment of segments) manager.execute({ type: 'ADD_SEGMENT', payload: { segment, pathId: path.id } });
  manager.commitTransaction();
  return path;
}

describe('SVG export', () => {
  it('uses a normalized artboard viewBox by default and preserves transparent icon padding', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const artboard = document.activeArtboard;
    manager.execute({
      type: 'UPDATE_ARTBOARD',
      payload: { artboardId: artboard.id, updates: { frame: { x: 100, y: 50, width: 1024, height: 768 } } },
    });
    manager.execute({
      type: 'UPDATE_ARTBOARD_DIMENSIONS',
      payload: { artboardId: artboard.id, width: 24, height: 24 },
    });
    const positions = [{ x: 104, y: 54 }, { x: 120, y: 54 }, { x: 120, y: 70 }, { x: 104, y: 70 }];
    const nodes = positions.map((position): VectorNode => ({ id: createEntityId(), position, constraintIds: [] }));
    const segments = nodes.map((node, index): Segment => ({
      id: createEntityId(),
      startNodeId: node.id,
      endNodeId: nodes[(index + 1) % nodes.length].id,
      type: 'line',
      role: 'geometry',
    }));
    addPath(document, manager, nodes, segments, true);

    const svg = exportDocumentToSvg(document);
    expect(svg).toContain('viewBox="0 0 24 24" width="24" height="24"');
    expect(svg).toContain('M4 4L20 4');
    expect(svg).not.toContain('<rect');
    expect(svg).not.toContain('<metadata');
    expect(svg).not.toContain('data-object-id');
    expect(svg).not.toContain('data-segment-id');
    expect(svg).not.toContain('Vector Studio');
  });

  it('exports a requested artboard without changing the active document location', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const source = document.activeArtboard;
    manager.execute({ type: 'UPDATE_ARTBOARD_DIMENSIONS', payload: { artboardId: source.id, width: 24, height: 24 } });
    const created = prepareCreateIconArtboard(document, 48, 32);
    manager.beginTransaction('Add second frame');
    created.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    expect(document.activeArtboardId).toBe(created.artboard.id);

    const sourceSvg = exportDocumentToSvg(document, { artboardId: source.id, includeMetadata: false });
    const secondSvg = exportDocumentToSvg(document, { artboardId: created.artboard.id, includeMetadata: false });
    expect(sourceSvg).toContain('viewBox="0 0 24 24" width="24" height="24"');
    expect(secondSvg).toContain('viewBox="0 0 48 32" width="48" height="32"');
    expect(document.activeArtboardId).toBe(created.artboard.id);
    expect(sourceSvg).not.toMatch(/data-[a-z-]+=/);
    expect(sourceSvg).not.toContain(source.id);
  });

  it('optionally includes the artboard background without changing normalized bounds', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const artboard = document.activeArtboard;
    manager.execute({
      type: 'UPDATE_ARTBOARD_DIMENSIONS',
      payload: { artboardId: artboard.id, width: 32, height: 32 },
    });
    manager.execute({
      type: 'UPDATE_ARTBOARD',
      payload: { artboardId: artboard.id, updates: { background: '#f4f1ea' } },
    });

    const svg = exportDocumentToSvg(document, { backgroundColor: document.activeArtboard.background });
    expect(svg).toContain('viewBox="0 0 32 32" width="32" height="32"');
    expect(svg).toContain('<rect x="0" y="0" width="32" height="32" fill="#f4f1ea"/>');
  });

  it('retains tight artwork bounds as an explicit export mode', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const start: VectorNode = { id: createEntityId(), position: { x: 4, y: 4 }, constraintIds: [] };
    const end: VectorNode = { id: createEntityId(), position: { x: 20, y: 4 }, constraintIds: [] };
    addPath(document, manager, [start, end], [{
      id: createEntityId(), startNodeId: start.id, endNodeId: end.id, type: 'line', role: 'geometry',
    }]);
    expect(exportDocumentToSvg(document, { exportBoundsMode: 'artwork', padding: 0 }))
      .toContain('viewBox="4 4 16 1" width="16" height="1"');
  });

  it('exports native arcs, variable widths, and concrete repeat instances', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const start: VectorNode = { id: createEntityId(), position: { x: 10, y: 0 }, constraintIds: [] };
    const end: VectorNode = { id: createEntityId(), position: { x: 0, y: 10 }, constraintIds: [] };
    const tail: VectorNode = { id: createEntityId(), position: { x: -12, y: 10 }, constraintIds: [] };
    const arc: Segment = {
      id: createEntityId(), startNodeId: start.id, endNodeId: end.id, type: 'arc', role: 'geometry',
      center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2, clockwise: false,
    };
    const wideLine: Segment = {
      id: createEntityId(), startNodeId: end.id, endNodeId: tail.id, type: 'line', role: 'geometry',
      widthProfile: [{ id: createEntityId(), t: 0.5, width: 6 }],
    };
    const path = addPath(document, manager, [start, end, tail], [arc, wideLine]);
    manager.execute({
      type: 'ADD_PARAMETRIC_GROUP',
      payload: { group: {
        id: createEntityId(), sourcePathIds: [path.id],
        transform: { type: 'radial', center: { x: 0, y: 0 }, count: 4, sweepAngle: 360 },
      } },
    });

    const svg = exportDocumentToSvg(document, { precision: 3, includeMetadata: true });
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg.match(new RegExp(`data-segment-id="${arc.id}"`, 'g'))).toHaveLength(4);
    expect(svg.match(new RegExp(`data-segment-id="${wideLine.id}"`, 'g'))).toHaveLength(4);
    expect(svg).toMatch(/A10 10 0 0 1/);
    expect(svg).toContain(' fill="#c8ced9"');
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
  });

  it('excludes construction geometry from normal export bounds', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const artworkStart: VectorNode = { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] };
    const artworkEnd: VectorNode = { id: createEntityId(), position: { x: 10, y: 0 }, constraintIds: [] };
    addPath(document, manager, [artworkStart, artworkEnd], [{
      id: createEntityId(),
      startNodeId: artworkStart.id,
      endNodeId: artworkEnd.id,
      type: 'line',
      role: 'geometry',
    }]);
    const guideStart: VectorNode = { id: createEntityId(), position: { x: 1000, y: 1000 }, constraintIds: [] };
    const guideEnd: VectorNode = { id: createEntityId(), position: { x: 1100, y: 1000 }, constraintIds: [] };
    const guide: Segment = {
      id: createEntityId(),
      startNodeId: guideStart.id,
      endNodeId: guideEnd.id,
      type: 'line',
      role: 'construction',
      constructionExtent: 'infinite',
    };
    addPath(document, manager, [guideStart, guideEnd], [guide]);

    const svg = exportDocumentToSvg(document, { exportBoundsMode: 'artwork', includeMetadata: true });
    expect(svg).toContain('viewBox="-8 -8 26 16"');
    expect(svg).not.toContain(guide.id);
    expect(svg).toContain('&quot;version&quot;:6');
  });

  it('returns a deterministic empty v6 SVG for construction-only documents', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const start: VectorNode = { id: createEntityId(), position: { x: -5000, y: 1200 }, constraintIds: [] };
    const end: VectorNode = { id: createEntityId(), position: { x: 8000, y: -900 }, constraintIds: [] };
    const guide: Segment = {
      id: createEntityId(),
      startNodeId: start.id,
      endNodeId: end.id,
      type: 'line',
      role: 'construction',
      constructionExtent: 'infinite',
    };
    addPath(document, manager, [start, end], [guide]);

    const first = exportDocumentToSvg(document, { exportBoundsMode: 'artwork', includeMetadata: true });
    const second = exportDocumentToSvg(new VectorDocument(document.toSnapshot()), { exportBoundsMode: 'artwork', includeMetadata: true });
    expect(first).toBe(second);
    expect(first).toContain('viewBox="0 0 1 1" width="1" height="1"');
    expect(first).toContain('&quot;version&quot;:6');
    expect(first).not.toContain('<path');
    expect(first).not.toContain(guide.id);
    expect(first).not.toContain('construction');
  });

  it('resolves v6 object appearance and layer visibility in standalone output', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const first: VectorNode = { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] };
    const second: VectorNode = { id: createEntityId(), position: { x: 30, y: 0 }, constraintIds: [] };
    const segment: Segment = {
      id: createEntityId(), startNodeId: first.id, endNodeId: second.id, type: 'line', role: 'geometry',
    };
    addPath(document, manager, [first, second], [segment]);
    const object = document.getObjectForSegment(segment.id)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    manager.execute({
      type: 'UPDATE_APPEARANCE',
      payload: {
        appearanceId: appearance.id,
        updates: {
          stroke: {
            color: '#12ab34', width: 3.5, cap: 'square', join: 'bevel', alignment: 'center',
            opacity: 0.5, dash: [8, 4], visible: true,
          },
          opacity: 0.8,
        },
      },
    });
    const styled = exportDocumentToSvg(document);
    expect(styled).toContain('stroke="#12ab34"');
    expect(styled).toContain('stroke-width="3.5"');
    expect(styled).toContain('stroke-linecap="square"');
    expect(styled).toContain('stroke-dasharray="8 4"');
    expect(styled).toContain('stroke-opacity="0.4"');

    const objectLayer = document.getLayerForObject(object.id)!;
    manager.execute({ type: 'UPDATE_LAYER', payload: { layerId: objectLayer.id, updates: { visible: false } } });
    expect(exportDocumentToSvg(document, { includeMetadata: true })).not.toContain(`data-segment-id="${segment.id}"`);
    manager.undo();
    expect(exportDocumentToSvg(document, { includeMetadata: true })).toContain(`data-segment-id="${segment.id}"`);
  });

  it('preserves center, inside, and outside stroke alignment for closed paths', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const points = [{ x: 4, y: 4 }, { x: 28, y: 4 }, { x: 28, y: 28 }, { x: 4, y: 28 }];
    const nodes = points.map((position): VectorNode => ({ id: createEntityId(), position, constraintIds: [] }));
    const segments = nodes.map((node, index): Segment => ({
      id: createEntityId(), startNodeId: node.id, endNodeId: nodes[(index + 1) % nodes.length].id,
      type: 'line', role: 'geometry',
    }));
    addPath(document, manager, nodes, segments, true);
    const object = document.getObjectForSegment(segments[0].id)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    const originalStroke = appearance.stroke!;

    manager.execute({ type: 'UPDATE_APPEARANCE', payload: {
      appearanceId: appearance.id,
      updates: { stroke: { ...originalStroke, width: 4, alignment: 'center' } },
    } });
    const centered = exportDocumentToSvg(document);
    expect(centered).toContain('stroke-width="4"');
    expect(centered).not.toContain('<clipPath');
    expect(centered).not.toContain('<mask');

    manager.execute({ type: 'UPDATE_APPEARANCE', payload: {
      appearanceId: appearance.id,
      updates: { stroke: { ...originalStroke, width: 4, alignment: 'inside' } },
    } });
    const inside = exportDocumentToSvg(document);
    expect(inside).toContain('<clipPath id="paint-1"');
    expect(inside).toContain('stroke-width="8"');
    expect(inside).toContain('clip-path="url(#paint-1)');

    manager.execute({ type: 'UPDATE_APPEARANCE', payload: {
      appearanceId: appearance.id,
      updates: { stroke: { ...originalStroke, width: 4, alignment: 'outside' } },
    } });
    const outside = exportDocumentToSvg(document);
    expect(outside).toContain('<mask id="paint-1"');
    expect(outside).toContain('stroke-width="8"');
    expect(outside).toContain('mask="url(#paint-1)');
  });

  it('leaves an open path centered when an ineligible alignment value is stored', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const start: VectorNode = { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] };
    const end: VectorNode = { id: createEntityId(), position: { x: 20, y: 0 }, constraintIds: [] };
    const segment: Segment = {
      id: createEntityId(), startNodeId: start.id, endNodeId: end.id, type: 'line', role: 'geometry',
    };
    addPath(document, manager, [start, end], [segment]);
    const object = document.getObjectForSegment(segment.id)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    manager.execute({ type: 'UPDATE_APPEARANCE', payload: {
      appearanceId: appearance.id,
      updates: { stroke: { ...appearance.stroke!, width: 5, alignment: 'outside' } },
    } });
    const svg = exportDocumentToSvg(document);
    expect(svg).toContain('stroke-width="5"');
    expect(svg).not.toContain('<mask');
    expect(svg).not.toContain('<clipPath');
  });

  it('exports stable region fills into a standalone dependency-free file', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const points = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }];
    const nodes = points.map((position): VectorNode => ({ id: createEntityId(), position, constraintIds: [] }));
    const segments = nodes.map((node, index): Segment => ({
      id: createEntityId(), startNodeId: node.id, endNodeId: nodes[(index + 1) % nodes.length].id, type: 'line', role: 'geometry',
    }));
    const path = addPath(document, manager, nodes, segments, true);
    const region = document.regions[0];
    manager.execute({ type: 'SET_REGION_FILL', payload: { regionId: region.id, fill: { type: 'solid', color: '#ff3366' } } });
    manager.execute({ type: 'ADD_PARAMETRIC_GROUP', payload: { group: {
      id: createEntityId(), sourcePathIds: [path.id],
      transform: { type: 'radial', center: { x: 80, y: 15 }, count: 2, sweepAngle: 360 },
    } } });
    const svg = exportDocumentToSvg(document, { includeMetadata: true });
    expect(svg.match(new RegExp(`data-region-id="${region.id}"`, 'g'))).toHaveLength(2);
    expect(svg).toContain('data-parametric-instance="1"');
    expect(svg).toContain('fill="#ff3366"');
    expect(svg).toContain('fill-rule="nonzero"');
    expect(svg).not.toMatch(/<script|(?:xlink:)?href=/);
  });

  it('exports compound outer and hole loops with the assigned fill rule', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const addPolygon = (points: Array<{ x: number; y: number }>) => {
      const nodes = points.map((position): VectorNode => ({ id: createEntityId(), position, constraintIds: [] }));
      const segments = nodes.map((node, index): Segment => ({
        id: createEntityId(), startNodeId: node.id, endNodeId: nodes[(index + 1) % nodes.length].id,
        type: 'line', role: 'geometry',
      }));
      addPath(document, manager, nodes, segments, true);
    };
    addPolygon([{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 120 }, { x: 0, y: 120 }]);
    addPolygon([{ x: 30, y: 30 }, { x: 30, y: 90 }, { x: 90, y: 90 }, { x: 90, y: 30 }]);
    const compound = document.regions.find((region) => region.innerLoops.length === 1)!;
    manager.execute({ type: 'SET_REGION_FILL', payload: {
      regionId: compound.id, fill: { type: 'solid', color: '#11aa77' },
    } });
    manager.execute({ type: 'SET_REGION_FILL_RULE', payload: { regionId: compound.id, fillRule: 'evenodd' } });

    const svg = exportDocumentToSvg(document, { padding: 0, exportBoundsMode: 'artwork', includeMetadata: true });
    const regionPath = svg.match(new RegExp(`<path d="([^"]+)" fill="#11aa77" fill-rule="evenodd" data-region-id="${compound.id}"/>`));
    expect(regionPath).not.toBeNull();
    expect(regionPath![1].match(/M/g)).toHaveLength(2);
    expect(svg).toContain('viewBox="0 0 120 120"');
  });
});


describe('SVG preview trust boundary', () => {
  it('normalizes untrusted stroke enums instead of interpolating executable attributes', () => {
    const document = VectorDocument.createEmpty(); const manager = new OperationManager(document);
    const nodes: VectorNode[] = [
      { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] },
      { id: createEntityId(), position: { x: 10, y: 10 }, constraintIds: [] },
    ];
    const segment: Segment = { id: createEntityId(), startNodeId: nodes[0].id, endNodeId: nodes[1].id, type: 'line', role: 'geometry' };
    addPath(document, manager, nodes, [segment]);
    const object = [...document.objects.values()].find((item) => item.networkId === document.activeNetwork.id)!;
    const appearance = document.getAppearance(object.appearanceId)!;
    // Reproduce malformed peer/clipboard data reaching a typed snapshot.
    appearance.stroke!.cap = 'round" onload="alert(1)' as 'round';
    appearance.stroke!.join = 'round"/><script>alert(2)</script><path x="' as 'round';
    const svg = exportDocumentToSvg(document);
    expect(svg).toContain('stroke-linecap="round" stroke-linejoin="round"');
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('<script');
  });
});
