import { afterEach, describe, expect, it, vi } from 'vitest';
import { VectorDocument } from '../core/document';
import { createEntityId } from '../core/ids';
import { OperationManager, type OperationDescriptor } from '../core/operations';
import type { DocumentSnapshot, VectorNode } from '../core/types';
import { preparePrimitiveObject } from '../tools/primitive-tool';
import {
  applyCollaborativeSnapshot,
  collaborationSchemaCompatibilityNotice,
  collaborationServerUrl,
  replayCollaborativeOperations,
  snapshotHash,
  type CollaborativeOperation,
} from './session';

function entry(operation: OperationDescriptor, clientId: string, sequence: number): CollaborativeOperation {
  return { id: operation.id, clientId, sequence, timestamp: operation.timestamp, operation };
}

function geometryLineFixture() {
  const document = VectorDocument.createEmpty();
  const manager = new OperationManager(document);
  const plan = preparePrimitiveObject(document, 'line', { x: 0, y: 0 }, { x: 80, y: 0 });
  if (!plan) throw new Error('Line fixture was not created.');
  manager.beginTransaction('Line fixture');
  plan.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  const network = document.getNetwork(plan.networkId)!;
  const path = document.getPath(network.pathIds[0])!;
  return { document, segmentId: path.segmentIds[0] };
}

describe('deterministic collaboration replay', () => {
  it('converges concurrent operations through one canonical Yjs log order', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const node: VectorNode = { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] };
    manager.execute({ type: 'ADD_NODE', payload: { node, networkId: document.activeNetwork.id } });
    const initial = document.toSnapshot();
    const first: OperationDescriptor = {
      id: createEntityId(), type: 'MOVE_NODE', timestamp: 1,
      payload: { nodeId: node.id, delta: { x: 5, y: 2 } },
    };
    const second: OperationDescriptor = {
      id: createEntityId(), type: 'MOVE_NODE', timestamp: 2,
      payload: { nodeId: node.id, delta: { x: 7, y: -1 } },
    };
    const a = replayCollaborativeOperations(initial, [entry(first, 'a', 1), entry(second, 'b', 1)]);
    const b = replayCollaborativeOperations(initial, [entry(first, 'a', 1), entry(second, 'b', 1)]);
    expect(a.conflicts).toEqual([]);
    expect(a.snapshot).toEqual(b.snapshot);
    expect(new VectorDocument(a.snapshot).getNode(node.id)?.position).toEqual({ x: 12, y: 1 });
  });

  it('resolves conflicting absolute geometry edits by canonical log order', () => {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const node: VectorNode = { id: createEntityId(), position: { x: 0, y: 0 }, constraintIds: [] };
    manager.execute({ type: 'ADD_NODE', payload: { node, networkId: document.activeNetwork.id } });
    const first: OperationDescriptor = {
      id: createEntityId(), type: 'SET_NODE_POSITIONS', timestamp: 10,
      payload: { positions: [{ nodeId: node.id, position: { x: 20, y: 30 } }] },
    };
    const second: OperationDescriptor = {
      id: createEntityId(), type: 'SET_NODE_POSITIONS', timestamp: 10,
      payload: { positions: [{ nodeId: node.id, position: { x: -4, y: 7 } }] },
    };
    const result = replayCollaborativeOperations(document.toSnapshot(), [
      entry(first, 'client-a', 1), entry(second, 'client-b', 1),
    ]);
    expect(new VectorDocument(result.snapshot).getNode(node.id)?.position).toEqual({ x: -4, y: 7 });
  });

  it('converges object transforms and appearance edits without changing network identity', () => {
    const document = VectorDocument.createEmpty();
    const object = [...document.objects.values()][0];
    const appearance = document.getAppearance(object.appearanceId)!;
    const transform: OperationDescriptor = {
      id: createEntityId(), type: 'UPDATE_OBJECT', timestamp: 20,
      payload: {
        objectId: object.id,
        updates: { name: 'Remote mark', transform: { x: 120, y: -40, rotation: 30, scaleX: 2, scaleY: 0.5 } },
      },
    };
    const paint: OperationDescriptor = {
      id: createEntityId(), type: 'UPDATE_APPEARANCE', timestamp: 21,
      payload: {
        appearanceId: appearance.id,
        updates: { fills: [{ type: 'solid', color: '#ff3366', opacity: 0.7, visible: true }] },
      },
    };
    const result = replayCollaborativeOperations(document.toSnapshot(), [
      entry(transform, 'remote', 1), entry(paint, 'remote', 2),
    ]);
    const restored = new VectorDocument(result.snapshot);
    expect(result.conflicts).toEqual([]);
    expect(restored.getObject(object.id)).toMatchObject({
      name: 'Remote mark', networkId: object.networkId,
      transform: { x: 120, y: -40, rotation: 30, scaleX: 2, scaleY: 0.5 },
    });
    expect(restored.getAppearance(appearance.id)?.fills[0]).toMatchObject({ color: '#ff3366', opacity: 0.7 });
  });

  it('serializes and replays offline role and extent edits in canonical log order', () => {
    const { document, segmentId } = geometryLineFixture();
    const makeConstruction: OperationDescriptor = {
      id: createEntityId(),
      type: 'SET_SEGMENT_ROLES',
      timestamp: 30,
      payload: { segments: [{ segmentId, role: 'construction', constructionExtent: 'infinite' }] },
    };
    const editOfflineExtent: OperationDescriptor = {
      id: createEntityId(),
      type: 'SET_SEGMENT_ROLES',
      timestamp: 31,
      payload: { segments: [{ segmentId, role: 'construction', constructionExtent: 'finite' }] },
    };
    const transported = JSON.parse(JSON.stringify([
      entry(makeConstruction, 'online-client', 1),
      entry(editOfflineExtent, 'offline-client', 1),
    ])) as CollaborativeOperation[];
    const result = replayCollaborativeOperations(document.toSnapshot(), transported);
    expect(result.conflicts).toEqual([]);
    expect(new VectorDocument(result.snapshot).getSegment(segmentId)).toMatchObject({
      role: 'construction',
      constructionExtent: 'finite',
    });
  });

  it('migrates a v5 initial snapshot before replaying role operations', () => {
    const { document, segmentId } = geometryLineFixture();
    const snapshot = document.toSnapshot();
    const legacy = {
      ...snapshot,
      version: 5,
      segments: snapshot.segments.map(([id, segment]) => {
        const { role: _role, constructionExtent: _extent, ...stored } = segment;
        return [id, stored];
      }),
    } as DocumentSnapshot;
    const operation: OperationDescriptor = {
      id: createEntityId(),
      type: 'SET_SEGMENT_ROLES',
      timestamp: 40,
      payload: { segments: [{ segmentId, role: 'construction', constructionExtent: 'infinite' }] },
    };
    const result = replayCollaborativeOperations(legacy, [entry(operation, 'remote', 1)]);
    expect(result.conflicts).toEqual([]);
    expect(result.snapshot.version).toBe(6);
    expect(new VectorDocument(result.snapshot).getSegment(segmentId)).toMatchObject({
      role: 'construction',
      constructionExtent: 'infinite',
    });
  });

  it('replays legacy snapshots and hashes equivalent key order identically', () => {
    const snapshot = VectorDocument.createEmpty().toSnapshot();
    const legacy = { ...snapshot, version: 3 } as typeof snapshot;
    delete (legacy as unknown as { exportVariables?: unknown }).exportVariables;
    const replayed = replayCollaborativeOperations(legacy, []);
    expect(replayed.snapshot.exportVariables).toEqual([]);
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as typeof snapshot;
    expect(snapshotHash(snapshot)).toBe(snapshotHash(reordered));
  });

  it('deterministically rejects invalid remote operations without corrupting the snapshot', () => {
    const document = VectorDocument.createEmpty();
    const invalid: OperationDescriptor = {
      id: createEntityId(), type: 'MOVE_NODE', timestamp: 1,
      payload: { nodeId: 'missing', delta: { x: 10, y: 10 } },
    };
    const result = replayCollaborativeOperations(document.toSnapshot(), [entry(invalid, 'remote', 1)]);
    expect(result.conflicts).toHaveLength(1);
    expect(new VectorDocument(result.snapshot).nodes.size).toBe(0);
  });

  it('reports malformed remote role operations as replay conflicts', () => {
    const { document, segmentId } = geometryLineFixture();
    const malformed: OperationDescriptor = {
      id: createEntityId(),
      type: 'SET_SEGMENT_ROLES',
      timestamp: 50,
      payload: { segments: [{ segmentId, role: 'construction' }] },
    };
    const result = replayCollaborativeOperations(document.toSnapshot(), [entry(malformed, 'remote', 1)]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain(malformed.id);
    expect(new VectorDocument(result.snapshot).getSegment(segmentId)).toMatchObject({
      role: 'geometry',
      constructionExtent: undefined,
    });
  });

  it('creates a deterministic notice for newer canonical room schemas', () => {
    expect(collaborationSchemaCompatibilityNotice({ version: 6 })).toBeUndefined();
    expect(collaborationSchemaCompatibilityNotice({ version: 7 })).toBe(
      'This room uses document schema v7; this client supports v6. Update Keyline before editing this room.',
    );
  });
});


afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('same-origin collaboration transport', () => {
  it.each([
    ['http:', 'localhost:5173', 'ws://localhost:5173/collaboration'],
    ['https:', '5173-preview.e2b.app', 'wss://5173-preview.e2b.app/collaboration'],
    ['https:', 'editor.example', 'wss://editor.example/collaboration'],
  ])('uses the app proxy for %s%s', (protocol, host, expected) => {
    vi.stubEnv('VITE_COLLABORATION_URL', '');
    vi.stubGlobal('window', { location: { protocol, host } });
    expect(collaborationServerUrl()).toBe(expected);
  });

  it('honors an explicitly configured external relay', () => {
    vi.stubEnv('VITE_COLLABORATION_URL', 'wss://relay.example/collaboration/');
    expect(collaborationServerUrl()).toBe('wss://relay.example/collaboration');
  });
});


describe('shared snapshot file isolation', () => {
  it('keeps the local file ID while importing shared geometry', () => {
    const { document: remote } = geometryLineFixture();
    const local = VectorDocument.createEmpty(); const localId = local.id;
    const manager = new OperationManager(local); const snapshot = remote.toSnapshot();
    applyCollaborativeSnapshot(manager, snapshot);
    expect(local.id).toBe(localId);
    expect(local.id).not.toBe(remote.id);
    expect(local.nodes.size).toBe(remote.nodes.size);
    expect(snapshot.id).toBe(remote.id);
  });

  it('does not repeatedly replace identical content solely because file IDs differ', () => {
    const { document: remote } = geometryLineFixture(); const local = VectorDocument.createEmpty();
    const manager = new OperationManager(local); const events = vi.fn(); manager.subscribe(events);
    applyCollaborativeSnapshot(manager, remote.toSnapshot());
    expect(snapshotHash({ ...local.toSnapshot(), id: remote.id })).toBe(snapshotHash(remote.toSnapshot()));
    applyCollaborativeSnapshot(manager, remote.toSnapshot());
    expect(events).toHaveBeenCalledTimes(1);
  });
});


it('hashes optional undefined fields the same way before and after JSON transport', () => {
  const { document } = geometryLineFixture();
  const snapshot = document.toSnapshot();
  const serialized = JSON.parse(JSON.stringify(snapshot)) as DocumentSnapshot;
  expect(snapshotHash(snapshot)).toBe(snapshotHash(serialized));
});
