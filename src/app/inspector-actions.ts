import type { VectorDocument } from '../core/document';
import type { EntityId, NetworkObject } from '../core/types';

/**
 * What the inspector may edit. Locking is a read-only state of the document; hiding is
 * only a view state, so a hidden shape stays editable from the panel even though the
 * canvas can no longer hit-test it. Anything else — a stale id, a removed object — is
 * refused, because the operation would be rejected anyway.
 */
export function canEditObject(document: VectorDocument, objectId: EntityId): boolean {
  return document.getObject(objectId) !== undefined && !document.isObjectLocked(objectId);
}

/** The objects an inspector command will really act on, in selection order. */
export function editableInspectorObjects(document: VectorDocument, objectIds: EntityId[]): NetworkObject[] {
  return objectIds
    .map((id) => document.getObject(id))
    .filter((object): object is NetworkObject => object !== undefined)
    .filter((object) => canEditObject(document, object.id));
}
