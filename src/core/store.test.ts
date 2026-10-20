import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VectorDocument } from './document';
import { parseDocumentBackup } from './document-backup';
import { createEntityId } from './ids';
import { OperationManager } from './operations';
import {
  DocumentPersistence, deleteStoredDocument, duplicateStoredDocument,
  listDocuments, loadDocumentById, renameStoredDocument, saveDocument,
} from './store';
import type { DocumentSnapshot } from './types';

function fixture() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const addNode = () => manager.execute({ type: 'ADD_NODE', payload: {
    node: { id: createEntityId(), position: { x: 1, y: 2 }, constraintIds: [] }, networkId: document.activeNetwork.id,
  } });
  return { document, manager, addNode };
}

const active: DocumentPersistence[] = [];
let page: EventTarget;
let browserDocument: EventTarget & { visibilityState: string };
beforeEach(() => {
  page = new EventTarget();
  browserDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', {
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args),
    addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page),
    document: browserDocument,
  });
});
afterEach(() => {
  for (const persistence of active.splice(0)) persistence.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function track(persistence: DocumentPersistence) { active.push(persistence); persistence.start(); return persistence; }

describe('IndexedDB document storage', () => {
  it('saves, renames, duplicates, reloads, and deletes a document', async () => {
    const { document, addNode } = fixture(); addNode();
    await saveDocument(document, 'Original');
    await renameStoredDocument(document.id, 'Renamed');
    expect((await loadDocumentById(document.id))?.name).toBe('Renamed');
    const duplicateId = createEntityId();
    expect(await duplicateStoredDocument(document.id, duplicateId)).toBe(duplicateId);
    const duplicate = await loadDocumentById(duplicateId);
    expect(duplicate?.document.id).toBe(duplicateId);
    expect(duplicate?.document.nodes.size).toBe(1);
    expect(duplicate?.name).toBe('Renamed copy');
    expect((await listDocuments()).some((item) => item.id === duplicateId)).toBe(true);
    await deleteStoredDocument(document.id); await deleteStoredDocument(duplicateId);
    expect(await loadDocumentById(document.id)).toBeNull();
  });

  it('restores a recovery backup as a new file and leaves the original intact', async () => {
    const { document, addNode } = fixture(); addNode();
    await saveDocument(document, 'Original');

    const backup = parseDocumentBackup(JSON.stringify(document.toSnapshot()), 'original.keyline.json');
    const restored = new VectorDocument({ ...backup.snapshot, id: createEntityId() });
    await saveDocument(restored, backup.name);

    const original = await loadDocumentById(document.id);
    const recovered = await loadDocumentById(restored.id);
    expect(original?.name).toBe('Original');
    expect(original?.document.nodes.size).toBe(1);
    expect(recovered?.name).toBe('original (restored)');
    expect(recovered?.document.id).toBe(restored.id);
    expect(recovered?.document.nodes.size).toBe(1);

    await deleteStoredDocument(document.id);
    await deleteStoredDocument(restored.id);
  });

  it('freezes geometry before awaiting IndexedDB or thumbnail generation', async () => {
    const { document, addNode } = fixture(); addNode();
    const saving = saveDocument(document, 'Frozen');
    addNode();
    await saving;
    expect(document.nodes.size).toBe(2);
    expect((await loadDocumentById(document.id))?.document.nodes.size).toBe(1);
    await deleteStoredDocument(document.id);
  });
});

describe('revision-aware autosave', () => {
  it('debounces changes and subscribes only once', async () => {
    vi.useFakeTimers();
    const { manager, addNode } = fixture(); const status = vi.fn(); const write = vi.fn(async () => {});
    const persistence = track(new DocumentPersistence(manager, status, () => 'Test', write));
    persistence.start();
    addNode(); addNode();
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith('saved');
  });

  it('serializes overlapping saves and never reports an older revision as saved', async () => {
    const { manager, addNode } = fixture(); const status = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshots: DocumentSnapshot[] = [];
    const write = vi.fn(async (document: VectorDocument) => {
      snapshots.push(document.toSnapshot());
      if (snapshots.length === 1) await gate;
    });
    const persistence = track(new DocumentPersistence(manager, status, () => 'Test', write));
    addNode(); const saving = persistence.flush();
    addNode(); const sameSave = persistence.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalledWith('saved');
    release(); await Promise.all([saving, sameSave]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(snapshots.map((snapshot) => snapshot.nodes.length)).toEqual([1, 2]);
    expect(status.mock.calls.filter(([value]) => value === 'saved')).toHaveLength(1);
  });

  it('flushes pending work when the page is hidden before the debounce expires', async () => {
    const { manager, addNode } = fixture(); const write = vi.fn(async () => {});
    const persistence = track(new DocumentPersistence(manager, vi.fn(), () => 'Test', write));
    addNode(); browserDocument.visibilityState = 'hidden';
    browserDocument.dispatchEvent(new Event('visibilitychange'));
    await persistence.flush();
    expect(write).toHaveBeenCalled();
  });

  it('flushes on pagehide and removes listeners when stopped', async () => {
    const { manager, addNode } = fixture(); const write = vi.fn(async () => {});
    const persistence = track(new DocumentPersistence(manager, vi.fn(), () => 'Test', write));
    addNode(); page.dispatchEvent(new Event('pagehide')); await persistence.flush();
    persistence.stop(); write.mockClear(); addNode(); page.dispatchEvent(new Event('pagehide'));
    expect(write).not.toHaveBeenCalled();
  });

  it('surfaces save failures and supports a later retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { manager, addNode } = fixture(); const status = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(new Error('Quota exceeded')).mockResolvedValue(undefined);
    const persistence = track(new DocumentPersistence(manager, status, () => 'Test', write));
    addNode(); await persistence.flush();
    expect(status).toHaveBeenLastCalledWith('error');
    await persistence.flush();
    expect(status).toHaveBeenLastCalledWith('saved');
  });
});
