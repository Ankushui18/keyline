import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import {
  VECTOR_CLIPBOARD_V1_PREFIX,
  createVectorClipboardPayload,
  parseVectorClipboard,
  preparePasteObjects,
  serializeVectorClipboard,
} from './clipboard';
import { prepareConstructionLineObject } from '../tools/construction-tool';
import { preparePrimitiveObject } from '../tools/primitive-tool';

function addRectangle(document: VectorDocument, manager: OperationManager) {
  const primitive = preparePrimitiveObject(document, 'rectangle', { x: 20, y: 30 }, { x: 140, y: 110 });
  if (!primitive) throw new Error('Rectangle plan was not created.');
  manager.beginTransaction('Rectangle');
  primitive.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return primitive;
}

describe('vector object clipboard', () => {
  it('copies and pastes typed graph objects with new IDs, region paint, and undo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const rectangle = addRectangle(document, manager);
    expect(document.regions).toHaveLength(1);
    manager.execute({
      type: 'SET_REGION_FILL',
      payload: { regionId: document.regions[0].id, fill: { type: 'solid', color: '#ff3366' } },
    });

    const payload = createVectorClipboardPayload(document, [rectangle.objectId]);
    expect(payload).not.toBeNull();
    const parsed = parseVectorClipboard(serializeVectorClipboard(payload!));
    expect(parsed).toEqual(payload);
    const plan = preparePasteObjects(document, parsed!, { offset: { x: 24, y: 18 } });
    expect(plan).not.toBeNull();

    manager.beginTransaction('Paste object');
    plan!.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();

    expect(document.objectsForArtboard(document.activeArtboardId).filter((object) =>
      (document.getNetwork(object.networkId)?.nodeIds.length ?? 0) > 0)).toHaveLength(2);
    expect(document.regions).toHaveLength(2);
    expect(document.regions.filter((region) => region.fill?.color === '#ff3366')).toHaveLength(2);
    expect(plan!.objectIds[0]).not.toBe(rectangle.objectId);
    expect(document.getObject(plan!.objectIds[0])?.transform).toMatchObject({ x: 44, y: 48 });
    expect(document.getObject(plan!.objectIds[0])?.name).toBe('Rectangle copy');

    expect(manager.undo()).toBe(true);
    expect(document.objectsForArtboard(document.activeArtboardId).filter((object) =>
      (document.getNetwork(object.networkId)?.nodeIds.length ?? 0) > 0)).toHaveLength(1);
    expect(document.regions).toHaveLength(1);
    expect(manager.redo()).toBe(true);
    expect(document.regions).toHaveLength(2);
    expect(document.regions.filter((region) => region.fill?.color === '#ff3366')).toHaveLength(2);
  });

  it('preserves names for cut-and-paste when no conflict remains', () => {
    const source = VectorDocument.createEmpty();
    const sourceManager = new OperationManager(source);
    const rectangle = addRectangle(source, sourceManager);
    const payload = createVectorClipboardPayload(source, [rectangle.objectId], 'cut')!;

    const target = VectorDocument.createEmpty();
    const plan = preparePasteObjects(target, payload, { preserveNames: true, offset: { x: 0, y: 0 } });
    expect(plan).not.toBeNull();
    const targetManager = new OperationManager(target);
    plan!.operations.forEach((operation) => targetManager.execute(operation));
    expect(target.getObject(plan!.objectIds[0])?.name).toBe('Rectangle');
  });

  it('uses v2 to preserve construction role, extent, and remapped constraints on paste', () => {
    const source = VectorDocument.createEmpty();
    const sourceManager = new OperationManager(source);
    const prepared = prepareConstructionLineObject(
      source,
      { x: 40, y: 60 },
      { x: 160, y: 60 },
      { extent: 'infinite' },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    sourceManager.beginTransaction('Construction fixture');
    prepared.plan.operations.forEach((operation) => sourceManager.execute(operation));
    sourceManager.commitTransaction();
    const constraintId = createEntityId();
    sourceManager.execute({
      type: 'ADD_CONSTRAINT',
      payload: { constraint: {
        id: constraintId,
        type: 'horizontal',
        targetIds: [prepared.plan.segmentId],
        priority: 'hard',
        enabled: true,
      } },
    });

    const payload = createVectorClipboardPayload(source, [prepared.plan.objectId])!;
    expect(payload.version).toBe(2);
    expect(payload.objects[0].segments[0]).toMatchObject({
      id: prepared.plan.segmentId,
      role: 'construction',
      constructionExtent: 'infinite',
    });
    expect(payload.regionFills).toEqual([]);
    const parsed = parseVectorClipboard(serializeVectorClipboard(payload));
    expect(parsed).toEqual(payload);
    const protectedPlan = preparePasteObjects(VectorDocument.createEmpty(), {
      ...parsed!,
      regionFills: [{
        boundarySegmentIds: [prepared.plan.segmentId],
        fill: { type: 'solid', color: '#ff0066' },
      }],
    });
    expect(protectedPlan?.operations.some((operation) => operation.type === 'SET_REGION_FILL')).toBe(false);

    const target = VectorDocument.createEmpty();
    const targetManager = new OperationManager(target);
    const paste = preparePasteObjects(target, parsed!, { offset: { x: 8, y: 12 } });
    expect(paste).not.toBeNull();
    targetManager.beginTransaction('Paste construction object');
    paste!.operations.forEach((operation) => targetManager.execute(operation));
    targetManager.commitTransaction();

    const pastedObject = target.getObject(paste!.objectIds[0])!;
    const pastedNetwork = target.getNetwork(pastedObject.networkId)!;
    const pastedPath = target.getPath(pastedNetwork.pathIds[0])!;
    const pastedSegment = target.getSegment(pastedPath.segmentIds[0])!;
    expect(pastedObject.id).not.toBe(prepared.plan.objectId);
    expect(pastedSegment.id).not.toBe(prepared.plan.segmentId);
    expect(pastedSegment).toMatchObject({
      role: 'construction',
      constructionExtent: 'infinite',
    });
    expect([...target.constraints.values()]).toHaveLength(1);
    expect([...target.constraints.values()][0]).toMatchObject({
      type: 'horizontal',
      targetIds: [pastedSegment.id],
    });
    expect([...target.constraints.keys()][0]).not.toBe(constraintId);
    expect(target.regions).toEqual([]);
  });

  it('migrates v1 clipboard segments to geometry and drops legacy construction metadata', () => {
    const source = VectorDocument.createEmpty();
    const sourceManager = new OperationManager(source);
    const rectangle = addRectangle(source, sourceManager);
    const current = createVectorClipboardPayload(source, [rectangle.objectId])!;
    const legacy = {
      ...current,
      version: 1,
      objects: current.objects.map((item) => ({
        ...item,
        segments: item.segments.map((segment) => ({
          ...segment,
          role: 'construction',
          constructionExtent: 'infinite',
        })),
      })),
    };
    const migrated = parseVectorClipboard(`${VECTOR_CLIPBOARD_V1_PREFIX}${JSON.stringify(legacy)}`);
    expect(migrated?.version).toBe(2);
    expect(migrated?.objects.flatMap((item) => item.segments).every((segment) =>
      segment.role === 'geometry' && segment.constructionExtent === undefined)).toBe(true);

    const target = VectorDocument.createEmpty();
    const plan = preparePasteObjects(target, migrated!, { offset: { x: 0, y: 0 } });
    expect(plan).not.toBeNull();
    const manager = new OperationManager(target);
    manager.beginTransaction('Paste migrated v1 object');
    plan!.operations.forEach((operation) => manager.execute(operation));
    manager.commitTransaction();
    expect([...target.segments.values()].every((segment) => segment.role === 'geometry')).toBe(true);
    expect(target.regions).toHaveLength(1);
  });
});
