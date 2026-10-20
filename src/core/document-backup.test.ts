import { describe, expect, it } from 'vitest';
import { VectorDocument } from './document';
import { backupDocumentName, parseDocumentBackup } from './document-backup';

function backupOf(document: VectorDocument): string {
  return JSON.stringify(document.toSnapshot());
}

describe('document backup restore', () => {
  it('accepts a snapshot written by the recovery download', () => {
    const original = VectorDocument.createEmpty();
    const backup = parseDocumentBackup(backupOf(original), 'my-icons.keyline.json');

    expect(backup.snapshot.version).toBe(6);
    expect(backup.snapshot.id).toBe(original.id);
    expect(backup.name).toBe('my-icons (restored)');

    // A restored document must be loadable through the ordinary constructor.
    const restored = new VectorDocument({ ...backup.snapshot, id: 'restored-id' });
    expect(restored.id).toBe('restored-id');
    expect(restored.pages.length).toBe(original.pages.length);
  });

  it('round-trips artwork geometry through a backup', () => {
    const original = VectorDocument.createEmpty();
    const artboardId = original.activePage.artboardIds[0];
    expect(original.getArtboard(artboardId)).toBeDefined();

    const restored = new VectorDocument({
      ...parseDocumentBackup(backupOf(original)).snapshot,
      id: 'restored-id',
    });

    expect(restored.getArtboard(artboardId)).toEqual(original.getArtboard(artboardId));
    expect(restored.toSnapshot()).toEqual({ ...original.toSnapshot(), id: 'restored-id' });
  });

  it('names restored files without duplicating the suffix', () => {
    expect(backupDocumentName('logo.keyline.json')).toBe('logo (restored)');
    expect(backupDocumentName('logo (restored).keyline.json')).toBe('logo (restored)');
    expect(backupDocumentName('.json')).toBe('Recovered drawing (restored)');
  });

  it('rejects files that are not backups', () => {
    expect(() => parseDocumentBackup('<svg/>')).toThrow(/not valid JSON/);
    expect(() => parseDocumentBackup('[]')).toThrow(/not a Keyline backup/);
    expect(() => parseDocumentBackup(JSON.stringify({ version: 99, id: 'x' }))).toThrow(/unsupported/);
    expect(() => parseDocumentBackup(JSON.stringify({ version: 6 }))).toThrow(/document ID/);
  });

  it('rejects malformed collections instead of trusting them', () => {
    const base = VectorDocument.createEmpty().toSnapshot();
    expect(() =>
      parseDocumentBackup(JSON.stringify({ ...base, nodes: [['node', 'not-an-object']] })),
    ).toThrow(/malformed nodes list/);
    expect(() =>
      parseDocumentBackup(JSON.stringify({ ...base, paths: 'oops' })),
    ).toThrow(/malformed paths list/);
    expect(() =>
      parseDocumentBackup(JSON.stringify({ ...base, regions: undefined })),
    ).toThrow(/missing its regions list/);
    expect(() =>
      parseDocumentBackup(JSON.stringify({ ...base, appearanceRules: {} })),
    ).toThrow(/malformed appearanceRules list/);
  });
});
