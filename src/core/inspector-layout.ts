import type { VectorDocument } from './document';
import { ARTWORK_BOUNDS_POLICY, INTERACTION_BOUNDS_POLICY, objectBounds, objectBoundsForTransform } from './object-geometry';
import type { EntityId, NetworkObject } from './types';

export type ObjectAlignment = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom';
export type LayoutArrangement = 'horizontal' | 'vertical' | 'grid';
export interface InspectorTransformUpdate { objectId: EntityId; transform: NetworkObject['transform'] }

function editableObjects(document: VectorDocument, ids: EntityId[]) {
  return [...new Set(ids)]
    .map((id) => document.getObject(id))
    .filter((object): object is NetworkObject => Boolean(object))
    .filter((object) => document.isObjectVisible(object.id) && !document.isObjectLocked(object.id))
    .map((object) => ({ object, bounds: objectBounds(document, object.id, ARTWORK_BOUNDS_POLICY) }));
}

/** One object aligns to its owning frame; a selection aligns to its combined bounds. */
export function alignmentUpdates(document: VectorDocument, ids: EntityId[], alignment: ObjectAlignment): InspectorTransformUpdate[] {
  const items = editableObjects(document, ids);
  if (!items.length) return [];
  let area = {
    minX: Math.min(...items.map(({ bounds }) => bounds.minX)),
    minY: Math.min(...items.map(({ bounds }) => bounds.minY)),
    maxX: Math.max(...items.map(({ bounds }) => bounds.maxX)),
    maxY: Math.max(...items.map(({ bounds }) => bounds.maxY)),
  };
  if (items.length === 1) {
    if (new Set(ids).size > 1) return [];
    const layer = document.getLayerForObject(items[0].object.id);
    const frame = layer ? document.getArtboard(layer.artboardId) : undefined;
    if (!frame || frame.isCanvasRoot) return [];
    area = { minX: frame.frame.x, minY: frame.frame.y, maxX: frame.frame.x + frame.frame.width, maxY: frame.frame.y + frame.frame.height };
  }
  const horizontal = alignment === 'left' || alignment === 'center-x' || alignment === 'right';
  const target = alignment === 'left' ? area.minX : alignment === 'right' ? area.maxX
    : alignment === 'top' ? area.minY : alignment === 'bottom' ? area.maxY
      : alignment === 'center-x' ? (area.minX + area.maxX) / 2 : (area.minY + area.maxY) / 2;
  return items.map(({ object, bounds }) => {
    const current = alignment === 'left' ? bounds.minX : alignment === 'right' ? bounds.maxX
      : alignment === 'top' ? bounds.minY : alignment === 'bottom' ? bounds.maxY
        : alignment === 'center-x' ? (bounds.minX + bounds.maxX) / 2 : (bounds.minY + bounds.maxY) / 2;
    return { objectId: object.id, transform: { ...object.transform, x: object.transform.x + (horizontal ? target - current : 0), y: object.transform.y + (horizontal ? 0 : target - current) } };
  }).filter(({ objectId, transform }) => {
    const current = document.getObject(objectId)!.transform;
    return Math.abs(current.x - transform.x) > 1e-9 || Math.abs(current.y - transform.y) > 1e-9;
  });
}

/** A one-shot arrange operation. Does not create or imply a persistent auto-layout container. */
export function arrangementUpdates(document: VectorDocument, ids: EntityId[], mode: LayoutArrangement, gap = 8): InspectorTransformUpdate[] {
  const items = editableObjects(document, ids).filter(({ bounds }) => bounds.width > 0 || bounds.height > 0);
  if (items.length < 2) return [];
  const spacing = Number.isFinite(gap) ? Math.max(0, gap) : 8;
  items.sort((a, b) => mode === 'horizontal'
    ? a.bounds.minX - b.bounds.minX || a.bounds.minY - b.bounds.minY
    : a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
  const origin = { x: Math.min(...items.map(({ bounds }) => bounds.minX)), y: Math.min(...items.map(({ bounds }) => bounds.minY)) };
  const columns = mode === 'grid' ? Math.ceil(Math.sqrt(items.length)) : 1;
  const cellWidth = Math.max(...items.map(({ bounds }) => bounds.width)) + spacing;
  const cellHeight = Math.max(...items.map(({ bounds }) => bounds.height)) + spacing;
  let x = origin.x;
  let y = origin.y;
  return items.map(({ object, bounds }, index) => {
    const targetX = mode === 'grid' ? origin.x + (index % columns) * cellWidth : x;
    const targetY = mode === 'grid' ? origin.y + Math.floor(index / columns) * cellHeight : y;
    if (mode === 'horizontal') x += bounds.width + spacing;
    if (mode === 'vertical') y += bounds.height + spacing;
    return { objectId: object.id, transform: { ...object.transform, x: object.transform.x + targetX - bounds.minX, y: object.transform.y + targetY - bounds.minY } };
  });
}

/** Equal vertical gaps while preserving the topmost and bottommost objects. */
export function verticalDistributionUpdates(document: VectorDocument, ids: EntityId[]): InspectorTransformUpdate[] {
  const items = editableObjects(document, ids).sort((a, b) => a.bounds.minY - b.bounds.minY);
  if (items.length < 3) return [];
  const start = items[0].bounds.minY;
  const end = items[items.length - 1].bounds.maxY;
  const gap = (end - start - items.reduce((sum, item) => sum + item.bounds.height, 0)) / (items.length - 1);
  let cursor = start;
  return items.map(({ object, bounds }) => {
    const transform = { ...object.transform, y: object.transform.y + cursor - bounds.minY };
    cursor += bounds.height + gap;
    return { objectId: object.id, transform };
  });
}

/** Resize around the visual top-left rather than drifting away from the position fields. */
export function resizedObjectTransform(document: VectorDocument, object: NetworkObject, dimension: 'width' | 'height', value: number, keepRatio: boolean): NetworkObject['transform'] {
  const bounds = objectBounds(document, object.id, INTERACTION_BOUNDS_POLICY);
  if (!Number.isFinite(value) || value <= 0 || bounds[dimension] < 1e-9) return { ...object.transform };
  const factor = value / bounds[dimension];
  const sideways = Math.abs(Math.sin(object.transform.rotation * Math.PI / 180)) > Math.abs(Math.cos(object.transform.rotation * Math.PI / 180));
  const changeX = keepRatio || (dimension === 'width' ? !sideways : sideways);
  const changeY = keepRatio || !changeX;
  const transform = { ...object.transform, scaleX: object.transform.scaleX * (changeX ? factor : 1), scaleY: object.transform.scaleY * (changeY ? factor : 1) };
  const next = objectBoundsForTransform(document, object.id, transform, INTERACTION_BOUNDS_POLICY);
  transform.x += bounds.minX - next.minX;
  transform.y += bounds.minY - next.minY;
  return transform;
}
