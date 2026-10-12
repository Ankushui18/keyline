import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager } from '../core/operations';
import type { Artboard, ExportDeliverySettings } from '../core/types';
import {
  createZipBlob,
  deliveryFilename,
  planDeliveryExports,
} from './delivery-export';
import {
  calculateRasterSize,
  CanvasExportLimitError,
  validateCanvasSize,
} from './png-export';

function artboard(name: string, id = createEntityId()): Artboard {
  return {
    id,
    pageId: 'page',
    name,
    frame: { x: 0, y: 0, width: 24, height: 24 },
    layerIds: [],
    background: '#ffffff',
    clipContent: true,
  };
}

const settings: ExportDeliverySettings = {
  boundsMode: 'artboard',
  includeBackground: false,
  formats: ['svg', 'png'],
  pngScales: [1, 2, 3],
  namingPattern: '{name}-{scale}.{format}',
};

describe('production delivery export', () => {
  it('calculates deterministic 1x, 2x, 3x, and custom PNG sizes', () => {
    const source = { width: 24, height: 18 };
    expect(calculateRasterSize(source, { scale: 1 })).toEqual({ width: 24, height: 18 });
    expect(calculateRasterSize(source, { scale: 2 })).toEqual({ width: 48, height: 36 });
    expect(calculateRasterSize(source, { scale: 3 })).toEqual({ width: 72, height: 54 });
    expect(calculateRasterSize(source, { customSize: { width: 127.6, height: 64.2 } }))
      .toEqual({ width: 128, height: 64 });
  });

  it('rejects unsafe browser canvas sizes with an actionable error', () => {
    expect(() => validateCanvasSize({ width: 20_000, height: 24 })).toThrow(CanvasExportLimitError);
    expect(() => validateCanvasSize({ width: 20_000, height: 24 })).toThrow(/smaller scale or custom size/i);
    expect(() => validateCanvasSize({ width: 16_384, height: 16_384 })).not.toThrow();
    expect(() => validateCanvasSize({ width: 16_384, height: 16_385 })).toThrow(/safe browser canvas limit/i);
  });

  it('builds deterministic token names and omits the empty SVG scale separator', () => {
    expect(deliveryFilename('{name}-{scale}.{format}', { name: 'Search 24', scale: '2x', format: 'png' }))
      .toBe('search-24-2x.png');
    expect(deliveryFilename('{name}-{scale}.{format}', { name: 'Home 24', scale: '', format: 'svg' }))
      .toBe('home-24.svg');
    expect(deliveryFilename('{name}@{scale}.{format}', { name: 'Arrow / Left', scale: '3x', format: 'png' }))
      .toBe('arrow-left@3x.png');
  });

  it('plans all artboard/format/scale combinations and blocks filename collisions', () => {
    const unique = planDeliveryExports([artboard('Search 24'), artboard('Home 24')], settings);
    expect(unique.targets.map((target) => target.filename)).toEqual([
      'search-24.svg', 'search-24-1x.png', 'search-24-2x.png', 'search-24-3x.png',
      'home-24.svg', 'home-24-1x.png', 'home-24-2x.png', 'home-24-3x.png',
    ]);
    expect(unique.collisions).toEqual([]);

    const duplicateNames = planDeliveryExports([artboard('Search 24'), artboard('search-24')], settings);
    expect(duplicateNames.collisions).toEqual([
      'search-24-1x.png', 'search-24-2x.png', 'search-24-3x.png', 'search-24.svg',
    ]);
  });

  it('supports a custom PNG size without forcing an additional 1x output', () => {
    const plan = planDeliveryExports([artboard('Custom')], {
      ...settings,
      formats: ['png'],
      pngScales: [],
      customSize: { width: 40, height: 30 },
    });
    expect(plan.targets).toMatchObject([
      { filename: 'custom-40x30.png', customSize: { width: 40, height: 30 } },
    ]);
  });

  it('creates a readable deterministic ZIP payload with every planned file', async () => {
    const blob = await createZipBlob([
      { filename: 'search-24.svg', data: '<svg viewBox="0 0 24 24"/>' },
      { filename: 'search-24-2x.png', data: new Uint8Array([137, 80, 78, 71]) },
    ]);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(['search-24-2x.png', 'search-24.svg']);
    await expect(zip.file('search-24.svg')!.async('string')).resolves.toContain('<svg');
    await expect(zip.file('search-24-2x.png')!.async('uint8array')).resolves.toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('persists presets and last-used settings transactionally through snapshots and Undo', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const preset = { id: createEntityId(), name: 'Icon Set Delivery', settings };
    manager.beginTransaction('Save export preset');
    manager.execute({
      type: 'UPDATE_EXPORT_METADATA',
      payload: { metadata: { lastUsed: settings, presets: [preset] } },
    });
    manager.commitTransaction();

    expect(document.exportMetadata.presets[0]).toMatchObject({ name: 'Icon Set Delivery' });
    const restored = new VectorDocument(document.toSnapshot());
    expect(restored.exportMetadata).toEqual(document.exportMetadata);
    expect(manager.undo()).toBe(true);
    expect(document.exportMetadata).toEqual({ presets: [] });
    expect(manager.redo()).toBe(true);
    expect(document.exportMetadata.lastUsed?.pngScales).toEqual([1, 2, 3]);
  });
});
