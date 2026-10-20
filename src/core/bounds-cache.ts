import type { VectorDocument } from './document';
import { INTERACTION_BOUNDS_POLICY, objectBounds, type GeometryBounds, type ObjectBoundsPolicy } from './object-geometry';
import type { EntityId } from './types';

interface CacheEntry {
  revision: number;
  bounds: Map<EntityId, GeometryBounds>;
}

const caches = new WeakMap<VectorDocument, Map<string, CacheEntry>>();

function policyKey(policy: ObjectBoundsPolicy): string {
  return `${policy.transformed}:${policy.includeConstruction}:${policy.includeParametricInstances}`;
}

/**
 * Object bounds are pure functions of the document, and a hover resolves them for
 * every object under the pointer on every pointer move. Caching them against the
 * document revision keeps that pass cheap without ever serving a stale answer: any
 * mutation bumps the revision and the next query recomputes.
 */
export function cachedObjectBounds(
  document: VectorDocument,
  objectId: EntityId,
  policy: ObjectBoundsPolicy = INTERACTION_BOUNDS_POLICY,
): GeometryBounds {
  let byDoc = caches.get(document);
  if (!byDoc) {
    byDoc = new Map();
    caches.set(document, byDoc);
  }
  const key = policyKey(policy);
  let entry = byDoc.get(key);
  if (!entry || entry.revision !== document.revision) {
    entry = { revision: document.revision, bounds: new Map() };
    byDoc.set(key, entry);
  }
  const hit = entry.bounds.get(objectId);
  if (hit) return hit;
  const bounds = objectBounds(document, objectId, policy);
  entry.bounds.set(objectId, bounds);
  return bounds;
}
