import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { prepareCreateIconArtboard } from './artboard-operations';
import {
  FRAME_PRESETS, framePreset, framePresetGroups, framePresetSize, isIconPreset,
} from './frame-presets';
import { OperationManager } from './operations';
import { prepareArtboardPlacement } from './artboard-operations';

function apply(manager: OperationManager, operations: ReturnType<typeof prepareCreateIconArtboard>['operations']) {
  manager.beginTransaction('Create frame');
  operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
}

describe('frame presets', () => {
  it('covers every group with at least one preset and unique ids', () => {
    const groups = framePresetGroups();
    expect(groups.map((entry) => entry.group)).toEqual(['Interface', 'Web', 'Device', 'Social', 'Print', 'Artwork']);
    for (const entry of groups) expect(entry.presets.length).toBeGreaterThan(0);
    const ids = FRAME_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of FRAME_PRESETS) {
      expect(preset.width).toBeGreaterThan(0);
      expect(preset.height).toBeGreaterThan(0);
    }
  });

  it('keeps the icon presets icon-named and gives every other preset its own name', () => {
    for (const preset of FRAME_PRESETS) {
      if (isIconPreset(preset)) expect(preset.name, preset.id).toBeUndefined();
      else expect(preset.name, preset.id).toBeTruthy();
    }
  });

  it('creates a general-purpose frame with the preset name and size', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const preset = framePreset('web-1440')!;
    const plan = prepareCreateIconArtboard(document, preset.width, preset.height, { name: preset.name });
    apply(manager, plan.operations);
    expect(document.activeArtboard.name).toBe('Web page');
    expect(document.activeArtboard.frame).toEqual({ x: 0, y: 0, width: 1440, height: 1024 });
    // The same plan drawn into still works: one path for every entry point.
    const placement = prepareArtboardPlacement(document, { x: 10, y: 10 });
    expect(placement.artboardId).toBe(document.activeArtboardId);
  });

  it('numbers duplicates of a named preset instead of repeating the name', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const preset = framePreset('social-square')!;
    apply(manager, prepareCreateIconArtboard(document, preset.width, preset.height, { name: preset.name }).operations);
    apply(manager, prepareCreateIconArtboard(document, preset.width, preset.height, { name: preset.name }).operations);
    expect([...document.artboards.values()].map((artboard) => artboard.name)).toEqual(['Social post', 'Social post 2']);
  });

  it('leaves the icon naming untouched when no name is supplied', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    apply(manager, prepareCreateIconArtboard(document, 24, 24).operations);
    expect(document.activeArtboard.name).toBe('Icon 24');
  });

  it('formats sizes once, with the multiplication sign the rest of the UI uses', () => {
    expect(framePresetSize(framePreset('print-a4')!)).toBe('794 × 1123');
  });

  it('places new artwork outside every frame on the page-level canvas root', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const preset = framePreset('icon-24')!;
    apply(manager, prepareCreateIconArtboard(document, preset.width, preset.height).operations);
    const inside = prepareArtboardPlacement(document, { x: 12, y: 12 });
    expect(inside.artboardId).toBe(document.activeArtboardId);
    const outside = prepareArtboardPlacement(document, { x: 5000, y: 5000 });
    // The canvas root is created on demand; the plan carries the operation that makes it.
    expect(outside.setupOperations.some((operation) => operation.type === 'ADD_ARTBOARD')).toBe(true);
    apply(manager, outside.setupOperations);
    expect(document.getArtboard(outside.artboardId)?.isCanvasRoot).toBe(true);
    // Drawing on the root never steals the active location from the frame you were in.
    expect(document.activeArtboardId).not.toBe(outside.artboardId);
  });
});
