import Dexie, { type EntityTable } from 'dexie';
import type { DocumentSnapshot } from './types';
import type { OperationManager } from './operations';
import { VectorDocument } from './document';
import { drawnObjectCount, drawnObjectsForArtboard, realArtboards } from './real-content';

interface StoredDocument {
  id: string;
  updatedAt: number;
  snapshot: DocumentSnapshot;
  /** Human file name. Older rows have none and fall back to "Untitled". */
  name?: string;
  createdAt?: number;
  /** Small SVG preview of the first artboard for the Dashboard. */
  thumb?: string;
  artboardCount?: number;
  objectCount?: number;
  kind?: 'icons' | 'logo' | 'imported';
}

export interface DocumentSummary {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  thumb?: string;
  artboardCount: number;
  objectCount: number;
  kind: 'icons' | 'logo' | 'imported';
}

export const DEFAULT_DOCUMENT_NAME = 'Untitled';
const MAX_THUMB_LENGTH = 60_000;

class VectorStudioDatabase extends Dexie {
  documents!: EntityTable<StoredDocument, 'id'>;

  constructor() {
    super('vector-studio');
    this.version(1).stores({ documents: 'id, updatedAt' });
  }
}

const database = new VectorStudioDatabase();

export type SaveStatus = 'saved' | 'saving' | 'error';

export async function loadMostRecentDocument(): Promise<VectorDocument | null> {
  const rows = await database.documents.orderBy('updatedAt').reverse().limit(1).toArray();
  return rows[0] ? new VectorDocument(rows[0].snapshot) : null;
}

export async function loadDocumentById(id: string): Promise<{ document: VectorDocument; name: string } | null> {
  const row = await database.documents.get(id);
  return row ? { document: new VectorDocument(row.snapshot), name: row.name ?? DEFAULT_DOCUMENT_NAME } : null;
}

function summarize(row: StoredDocument): DocumentSummary {
  return {
    id: row.id,
    name: row.name ?? DEFAULT_DOCUMENT_NAME,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt ?? row.updatedAt,
    thumb: row.thumb,
    artboardCount: row.artboardCount ?? 1,
    objectCount: row.objectCount ?? 0,
    kind: row.kind ?? 'icons',
  };
}

/** Newest first. Drawings that were opened but never edited are not stored, so they never appear. */
export async function listDocuments(): Promise<DocumentSummary[]> {
  const rows = await database.documents.orderBy('updatedAt').reverse().toArray();
  return rows.map(summarize);
}

export async function renameStoredDocument(id: string, name: string): Promise<void> {
  const trimmed = name.trim() || DEFAULT_DOCUMENT_NAME;
  await database.documents.update(id, { name: trimmed });
}

export async function deleteStoredDocument(id: string): Promise<void> {
  await database.documents.delete(id);
}

export async function duplicateStoredDocument(id: string, newId: string): Promise<string | null> {
  const row = await database.documents.get(id);
  if (!row) return null;
  const now = Date.now();
  await database.documents.put({
    ...row,
    id: newId,
    name: `${row.name ?? DEFAULT_DOCUMENT_NAME} copy`,
    createdAt: now,
    updatedAt: now,
    snapshot: { ...row.snapshot, id: newId },
  });
  return newId;
}

function documentKind(document: VectorDocument): StoredDocument['kind'] {
  const artboards = realArtboards(document);
  return artboards.length > 0 && artboards.every((artboard) => artboard.frame.width >= 256 || artboard.frame.height >= 256)
    ? 'logo'
    : 'icons';
}

async function buildThumbnail(document: VectorDocument): Promise<string | undefined> {
  const artboard = realArtboards(document).find((item) => drawnObjectsForArtboard(document, item.id).length > 0);
  if (!artboard) return undefined;
  try {
    const { exportDocumentToSvg } = await import('../export/svg-export');
    const svg = exportDocumentToSvg(document, {
      artboardId: artboard.id,
      exportBoundsMode: 'artboard',
      includeMetadata: false,
    });
    return svg.length <= MAX_THUMB_LENGTH ? svg : undefined;
  } catch {
    return undefined;
  }
}

export async function saveDocument(document: VectorDocument, name?: string): Promise<void> {
  const existing = await database.documents.get(document.id);
  const now = Date.now();
  const artboards = realArtboards(document);
  await database.documents.put({
    id: document.id,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
    name: name?.trim() || existing?.name || DEFAULT_DOCUMENT_NAME,
    kind: existing?.kind === 'imported' ? 'imported' : documentKind(document),
    thumb: await buildThumbnail(document) ?? existing?.thumb,
    artboardCount: artboards.length,
    objectCount: drawnObjectCount(document),
    snapshot: document.toSnapshot(),
  });
}

export async function markStoredDocumentImported(id: string): Promise<void> {
  await database.documents.update(id, { kind: 'imported' });
}

/** Debounced persistence attached only to committed semantic operations. */
export class DocumentPersistence {
  private timer: number | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly manager: OperationManager,
    private readonly onStatus: (status: SaveStatus) => void,
    private readonly getName: () => string = () => DEFAULT_DOCUMENT_NAME,
  ) {}

  start(): void {
    this.unsubscribe = this.manager.subscribe((event) => {
      if (!event.committed) return;
      this.onStatus('saving');
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.flush(), 500);
    });
  }

  async flush(): Promise<void> {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    try {
      await saveDocument(this.manager.document, this.getName());
      this.onStatus('saved');
    } catch (error) {
      console.error('Unable to save Keyline document.', error);
      this.onStatus('error');
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer !== undefined) void this.flush();
  }
}
