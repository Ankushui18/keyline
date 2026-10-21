import { describe, expect, it } from 'vitest';
import { prepareCreateIconArtboard, prepareDuplicateArtboard, removeLegacyIconStarter } from './artboard-operations';
import { VectorDocument } from './document';
import { createEntityId } from './ids';
import { OperationManager, type OperationInput } from './operations';
import { isUnusedStarterArtboard, realArtboards } from './real-content';

function apply(manager: OperationManager, operations: OperationInput[]) {
  manager.beginTransaction('Create icon');
  operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
}

function createLegacyIconFile() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const starterId = document.activeArtboardId;
  // Reproduce the previous append-only behavior, then restore the untouched template's original title.
  manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: starterId, updates: { name: 'Temporary' } } });
  const plan = prepareCreateIconArtboard(document, 24, 24);
  apply(manager, plan.operations);
  manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: starterId, updates: { name: 'Artboard 1' } } });
  const loaded = new VectorDocument(document.toSnapshot());
  return { document: loaded, manager: new OperationManager(loaded), starterId, iconId: plan.artboard.id };
}

describe('icon onboarding regression', () => {
  it.each([24, 32, 48, 64])('starts with exactly the chosen %i px icon frame', (size) => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const originalNetwork = document.activeNetwork.id;
    apply(manager, prepareCreateIconArtboard(document, size, size).operations);
    expect(realArtboards(document)).toHaveLength(1);
    expect(document.activeArtboard.name).toBe(`Icon ${size}`);
    expect(document.activeArtboard.frame).toEqual({ x: 0, y: 0, width: size, height: size });
    expect(document.activeNetwork.id).toBe(originalNetwork);
    expect(document.networks).toHaveLength(1);
    const reloaded = new VectorDocument(document.toSnapshot());
    expect(realArtboards(reloaded)).toHaveLength(1);
    expect(isUnusedStarterArtboard(reloaded, reloaded.activeArtboard)).toBe(false);
  });

  it('keeps every additional, intentionally blank icon frame visible and undoable', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    apply(manager, prepareCreateIconArtboard(document, 24, 24).operations);
    const firstId = document.activeArtboardId;
    const second = prepareCreateIconArtboard(document, 24, 24);
    apply(manager, second.operations);
    expect(realArtboards(document).map((frame) => frame.name)).toEqual(['Icon 24', 'Icon 24 2']);
    expect(second.artboard.id).not.toBe(firstId);
    expect(manager.undo()).toBe(true);
    expect(realArtboards(document).map((frame) => frame.id)).toEqual([firstId]);
    expect(manager.redo()).toBe(true);
    expect(realArtboards(document)).toHaveLength(2);
  });

  it('does not replace a starter that already contains even one point', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const starterId = document.activeArtboardId;
    const node = { id: createEntityId(), position: { x: 5, y: 8 }, constraintIds: [] };
    manager.execute({ type: 'ADD_NODE', payload: { node, networkId: document.activeNetwork.id } });
    apply(manager, prepareCreateIconArtboard(document, 24, 24).operations);
    expect(document.activeArtboardId).not.toBe(starterId);
    expect(realArtboards(document)).toHaveLength(2);
    expect(document.getNode(node.id)).toEqual(node);
    expect(removeLegacyIconStarter(manager)).toBeNull();
  });

  it.each([
    { name: 'My blank artboard' },
    { background: '#ff0000' },
    { frame: { x: -512, y: -384, width: 512, height: 768 } },
    { frame: { x: 10, y: 10, width: 1024, height: 768 } },
  ])('preserves customized blank starters: %j', (updates) => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const originalId = document.activeArtboardId;
    manager.execute({ type: 'UPDATE_ARTBOARD', payload: { artboardId: originalId, updates } });
    const original = structuredClone(document.activeArtboard);
    apply(manager, prepareCreateIconArtboard(document, 24, 24).operations);
    expect(document.getArtboard(originalId)).toEqual(original);
    expect(realArtboards(document)).toHaveLength(2);
    expect(removeLegacyIconStarter(manager)).toBeNull();
  });

  it('preserves an empty starter with a customized drawing appearance', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const originalId = document.activeArtboardId;
    const appearance = document.getAppearance(document.objectsForArtboard(originalId)[0].appearanceId)!;
    manager.execute({ type: 'UPDATE_APPEARANCE', payload: { appearanceId: appearance.id, updates: { fills: [{ type: 'solid', color: '#123456', opacity: 1, visible: true }] } } });
    apply(manager, prepareCreateIconArtboard(document, 24, 24).operations);
    expect(document.activeArtboardId).not.toBe(originalId);
    const stored = document.getAppearance(appearance.id)?.fills[0];
    expect(stored?.type === 'solid' ? stored.color : undefined).toBe('#123456');
    expect(removeLegacyIconStarter(manager)).toBeNull();
  });

  it('repairs the exact old two-frame icon-start result, with Undo and Redo', () => {
    const { document, manager, starterId, iconId } = createLegacyIconFile();
    expect(realArtboards(document)).toHaveLength(2);
    const icon = structuredClone(document.getArtboard(iconId));
    const original = structuredClone(document.getArtboard(starterId));
    expect(removeLegacyIconStarter(manager)?.artboardIds).toEqual([starterId]);
    expect(realArtboards(document).map((frame) => frame.id)).toEqual([iconId]);
    expect(document.getArtboard(iconId)).toEqual(icon);
    expect(document.networks).toHaveLength(1);
    expect(manager.undo()).toBe(true);
    expect(document.getArtboard(starterId)).toEqual(original);
    expect(document.getArtboard(iconId)).toEqual(icon);
    expect(manager.redo()).toBe(true);
    expect(realArtboards(document)).toHaveLength(1);
    expect(removeLegacyIconStarter(manager)).toBeNull();
  });

  it('does not clean up an intentionally duplicated blank default artboard', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const plan = prepareDuplicateArtboard(document, document.activeArtboardId)!;
    apply(manager, plan.operations);
    expect(realArtboards(document)).toHaveLength(2);
    expect(removeLegacyIconStarter(manager)).toBeNull();
    expect(realArtboards(document)).toHaveLength(2);
  });
});
