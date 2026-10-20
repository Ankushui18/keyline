import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { VectorDocument } from '../core/document';
import { OperationManager, type OperationDescriptor } from '../core/operations';
import type { DocumentSnapshot, Point, SelectionState } from '../core/types';

export type CollaborationStatus = 'connecting' | 'synced' | 'offline' | 'error';

export interface CollaboratorPresence {
  clientId: number;
  user: { id: string; name: string; color: string };
  cursor?: Point;
  selection?: {
    mode?: SelectionState['mode'];
    editingObjectId?: string;
    objectIds: string[];
    nodeIds: string[];
    segmentIds: string[];
  };
}

export interface CollaborativeOperation {
  id: string;
  clientId: string;
  sequence: number;
  timestamp: number;
  operation: OperationDescriptor;
}

interface CollaborationCallbacks {
  onStatus: (status: CollaborationStatus) => void;
  onPresence: (presence: CollaboratorPresence[]) => void;
  onReplayConflicts?: (messages: string[]) => void;
  onCompatibilityNotice?: (message: string) => void;
}

export class CollaborationSession {
  private readonly ydoc = new Y.Doc();
  private readonly operations = this.ydoc.getArray<CollaborativeOperation>('operations');
  private readonly metadata = this.ydoc.getMap<unknown>('metadata');
  private readonly canonical = this.ydoc.getMap<unknown>('canonical');
  private readonly persistence: IndexeddbPersistence;
  private readonly provider: WebsocketProvider;
  private readonly clientId = crypto.randomUUID();
  private sequence = 0;
  private unsubscribeManager: (() => void) | undefined;
  private reconcileQueued = false;
  private disposed = false;
  private reconnectStatusTimer: number | undefined;
  private compatibilityNoticeVersion: number | undefined;

  constructor(
    private readonly manager: OperationManager,
    readonly roomId: string,
    private readonly callbacks: CollaborationCallbacks,
    user: { id: string; name: string; color: string },
  ) {
    this.persistence = new IndexeddbPersistence(`vector-studio-room-${roomId}`, this.ydoc);
    this.provider = new WebsocketProvider(collaborationServerUrl(), roomId, this.ydoc, {
      connect: false,
    });
    this.provider.awareness.setLocalStateField('user', user);
    this.provider.awareness.setLocalStateField('cursor', undefined);
    this.provider.awareness.setLocalStateField('selection', {
      mode: 'object', objectIds: [], nodeIds: [], segmentIds: [],
    });
  }

  async start(): Promise<void> {
    this.callbacks.onStatus('connecting');
    await this.persistence.whenSynced;
    if (this.disposed) return;
    this.provider.connect();
    await Promise.race([
      new Promise<void>((resolve) => this.provider.once('sync', () => resolve())),
      new Promise<void>((resolve) => window.setTimeout(resolve, 800)),
    ]);
    if (this.disposed) return;
    if (!this.metadata.has('initialSnapshot')) {
      this.ydoc.transact(() => {
        if (!this.metadata.has('initialSnapshot')) {
          this.metadata.set('initialSnapshot', jsonClone(this.manager.document.toSnapshot()));
        }
      }, this.clientId);
    }
    this.scheduleReconcile();

    this.unsubscribeManager = this.manager.subscribe((event) => {
      if (!event.committed || !event.operation) return;
      const entry: CollaborativeOperation = {
        id: event.operation.id,
        clientId: this.clientId,
        sequence: ++this.sequence,
        timestamp: event.operation.timestamp,
        operation: jsonClone(event.operation),
      };
      this.ydoc.transact(() => this.operations.push([entry]), this.clientId);
    });
    this.operations.observe((event) => {
      if (event.transaction.origin !== this.clientId) this.scheduleReconcile();
    });
    this.metadata.observe((event) => {
      if (event.transaction.origin !== this.clientId) this.scheduleReconcile();
    });
    this.canonical.observe((event) => {
      if (event.transaction.origin !== this.clientId) this.scheduleReconcile();
    });
    this.provider.on('status', ({ status }: { status: string }) => {
      this.clearReconnectStatusTimer();
      if (status === 'connected') {
        this.callbacks.onStatus(this.provider.synced ? 'synced' : 'connecting');
        // Some y-websocket reconnects complete state-vector exchange without
        // re-emitting `sync`. A connected socket is considered healthy after
        // one handshake grace period; later errors still override this state.
        this.reconnectStatusTimer = window.setTimeout(() => {
          const connected = (this.provider as WebsocketProvider & { wsconnected?: boolean }).wsconnected !== false;
          if (!this.disposed && navigator.onLine && connected) this.callbacks.onStatus('synced');
        }, 900);
      } else {
        this.callbacks.onStatus(navigator.onLine ? 'connecting' : 'offline');
      }
    });
    this.provider.on('sync', (synced: boolean) => {
      this.clearReconnectStatusTimer();
      this.callbacks.onStatus(synced ? 'synced' : navigator.onLine ? 'connecting' : 'offline');
    });
    this.provider.on('connection-error', () => {
      this.clearReconnectStatusTimer();
      this.callbacks.onStatus(navigator.onLine ? 'error' : 'offline');
    });
    this.provider.awareness.on('change', () => this.publishPresence());
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    this.publishPresence();
    this.callbacks.onStatus(this.provider.synced ? 'synced' : navigator.onLine ? 'connecting' : 'offline');
  }

  setCursor(cursor?: Point): void {
    this.provider.awareness.setLocalStateField('cursor', cursor ? { ...cursor } : undefined);
  }

  setSelection(selection: SelectionState): void {
    this.provider.awareness.setLocalStateField('selection', {
      mode: selection.mode,
      editingObjectId: selection.editingObjectId,
      objectIds: [...selection.objectIds].sort(),
      nodeIds: [...selection.nodeIds].sort(),
      segmentIds: [...selection.segmentIds].sort(),
    });
  }

  destroy(): void {
    this.disposed = true;
    this.clearReconnectStatusTimer();
    this.unsubscribeManager?.();
    this.provider.destroy();
    void this.persistence.destroy();
    this.ydoc.destroy();
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }

  private readonly handleOnline = () => {
    this.clearReconnectStatusTimer();
    this.callbacks.onStatus('connecting');
    // Reset a possibly stale OPEN socket: browsers can dispatch `online`
    // before the WebSocket close event is observed by y-websocket.
    this.provider.disconnect();
    this.provider.connect();
  };

  private readonly handleOffline = () => {
    this.clearReconnectStatusTimer();
    this.callbacks.onStatus('offline');
  };

  private clearReconnectStatusTimer(): void {
    if (this.reconnectStatusTimer !== undefined) window.clearTimeout(this.reconnectStatusTimer);
    this.reconnectStatusTimer = undefined;
  }

  private scheduleReconcile(): void {
    if (this.reconcileQueued || this.disposed) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      if (this.disposed) return;
      const initial = this.metadata.get('initialSnapshot') as DocumentSnapshot | undefined;
      if (!initial) return;
      try {
        const entries = this.operations.toArray();
        const replayed = replayCollaborativeOperations(initial, entries);
        let snapshot = replayed.snapshot;
        const hash = snapshotHash(snapshot);
        const canonicalLength = this.canonical.get('operationCount') as number | undefined;
        const canonicalHash = this.canonical.get('hash') as string | undefined;
        const canonicalSnapshot = this.canonical.get('snapshot') as DocumentSnapshot | undefined;
        const compatibility = collaborationSchemaCompatibilityNotice(canonicalSnapshot);
        if (compatibility && canonicalSnapshot && canonicalSnapshot.version !== this.compatibilityNoticeVersion) {
          this.compatibilityNoticeVersion = canonicalSnapshot.version;
          this.callbacks.onCompatibilityNotice?.(compatibility);
        }
        if (canonicalLength === entries.length && canonicalHash && canonicalHash !== hash && canonicalSnapshot) {
          snapshot = jsonClone(canonicalSnapshot);
          replayed.conflicts.push('Local deterministic replay diverged; restored the shared canonical snapshot.');
        } else if (canonicalLength !== entries.length || canonicalHash !== hash) {
          this.ydoc.transact(() => {
            this.canonical.set('operationCount', entries.length);
            this.canonical.set('hash', hash);
            this.canonical.set('snapshot', jsonClone(snapshot));
          }, this.clientId);
        }
        applyCollaborativeSnapshot(this.manager, snapshot);
        this.callbacks.onReplayConflicts?.(replayed.conflicts);
      } catch (error) {
        this.callbacks.onStatus('error');
        this.callbacks.onReplayConflicts?.([
          `Unable to replay collaboration state: ${error instanceof Error ? error.message : String(error)}`,
        ]);
      }
    });
  }

  private publishPresence(): void {
    const presence: CollaboratorPresence[] = [];
    for (const [clientId, state] of this.provider.awareness.getStates()) {
      if (clientId === this.provider.awareness.clientID) continue;
      const candidate = state as Partial<CollaboratorPresence>;
      const user = safePresenceUser(candidate.user);
      if (!user) continue;
      const cursor = candidate.cursor && Number.isFinite(candidate.cursor.x) && Number.isFinite(candidate.cursor.y)
        ? { x: candidate.cursor.x, y: candidate.cursor.y }
        : undefined;
      const objectIds = Array.isArray(candidate.selection?.objectIds)
        ? candidate.selection.objectIds.filter((id): id is string => typeof id === 'string').slice(0, 1000)
        : [];
      const nodeIds = Array.isArray(candidate.selection?.nodeIds)
        ? candidate.selection.nodeIds.filter((id): id is string => typeof id === 'string').slice(0, 1000)
        : [];
      const segmentIds = Array.isArray(candidate.selection?.segmentIds)
        ? candidate.selection.segmentIds.filter((id): id is string => typeof id === 'string').slice(0, 1000)
        : [];
      const mode = candidate.selection?.mode === 'network' ? 'network' : 'object';
      const editingObjectId = typeof candidate.selection?.editingObjectId === 'string'
        ? candidate.selection.editingObjectId
        : undefined;
      presence.push({
        clientId,
        user,
        cursor,
        selection: { mode, editingObjectId, objectIds, nodeIds, segmentIds },
      });
    }
    presence.sort((a, b) => a.user.id.localeCompare(b.user.id));
    this.callbacks.onPresence(presence);
  }
}

export const CURRENT_COLLABORATION_SCHEMA_VERSION = 6;

export function collaborationSchemaCompatibilityNotice(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const version = (snapshot as { version?: unknown }).version;
  if (typeof version !== 'number' || !Number.isFinite(version) || version <= CURRENT_COLLABORATION_SCHEMA_VERSION) {
    return undefined;
  }
  return `This room uses document schema v${version}; this client supports v${CURRENT_COLLABORATION_SCHEMA_VERSION}. Update Keyline before editing this room.`;
}

export function replayCollaborativeOperations(
  initialSnapshot: DocumentSnapshot,
  entries: CollaborativeOperation[],
): { snapshot: DocumentSnapshot; conflicts: string[] } {
  const document = new VectorDocument(jsonClone(initialSnapshot));
  const manager = new OperationManager(document);
  const conflicts: string[] = [];
  for (const entry of entries) {
    try {
      manager.execute({
        id: entry.operation.id,
        type: entry.operation.type,
        timestamp: entry.operation.timestamp,
        payload: jsonClone(entry.operation.payload),
      });
    } catch (error) {
      conflicts.push(`${entry.operation.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { snapshot: document.toSnapshot(), conflicts };
}

function safePresenceUser(value: unknown): CollaboratorPresence['user'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<CollaboratorPresence['user']>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.color !== 'string') return undefined;
  if (candidate.id.length > 128 || candidate.name.length > 48 || !/^#[0-9a-fA-F]{6}$/.test(candidate.color)) return undefined;
  return { id: candidate.id, name: candidate.name, color: candidate.color };
}

export function collaborationServerUrl(): string {
  const configured = import.meta.env.VITE_COLLABORATION_URL;
  if (configured) return configured.replace(/\/$/, '');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Always use the app's same-origin WebSocket proxy. Browser localhost and
  // sibling preview ports are not the server, and may be blocked or unreachable.
  return `${protocol}//${window.location.host}/collaboration`;
}

/** Shared content must never replace this device's IndexedDB file identity. */
export function applyCollaborativeSnapshot(manager: OperationManager, snapshot: DocumentSnapshot): void {
  const localId = manager.document.id;
  const current = { ...manager.document.toSnapshot(), id: snapshot.id };
  if (snapshotHash(current) !== snapshotHash(snapshot)) {
    manager.replaceFromRemoteSnapshot({ ...jsonClone(snapshot), id: localId });
  }
}

export function snapshotHash(snapshot: DocumentSnapshot): string {
  const serialized = stableStringify(snapshot);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
