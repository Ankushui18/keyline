import type { VectorDocument } from './document';
import type { Artboard, NetworkObject } from './types';

/** An object with no points is the empty placeholder a new frame starts with, not something the person drew. */
export function isDrawnObject(document: VectorDocument, object: NetworkObject): boolean {
  const network = document.getNetwork(object.networkId);
  return Boolean(network && (network.nodeIds.length > 0 || network.pathIds.length > 0));
}

export function drawnObjectsForArtboard(document: VectorDocument, artboardId: string): NetworkObject[] {
  return document.objectsForArtboard(artboardId).filter((object) => isDrawnObject(document, object));
}

/** Every explicit frame counts, including intentionally blank frames. */
export function realArtboards(document: VectorDocument): Artboard[] {
  return [...document.artboards.values()].filter((artboard) => !artboard.isCanvasRoot);
}

/** Recognize the untouched, automatically migrated starter, never merely an empty or similarly named frame. */
export function isUnusedStarterArtboard(document: VectorDocument, artboard: Artboard): boolean {
  if (artboard.id !== `${document.id}:artboard:1` || artboard.name !== 'Artboard 1' ||
    artboard.isCanvasRoot || artboard.clipContent || artboard.background !== '#ffffff' ||
    artboard.frame.x !== -512 || artboard.frame.y !== -384 ||
    artboard.frame.width !== 1024 || artboard.frame.height !== 768) return false;
  const objects = document.objectsForArtboard(artboard.id);
  if (objects.length !== 1) return false;
  const object = objects[0];
  const network = document.getNetwork(object.networkId);
  const appearance = document.getAppearance(object.appearanceId);
  const layer = document.getLayerForObject(object.id);
  const root = document.getLayer(`${document.id}:layer:1`);
  const layers = [...document.layers.values()].filter((item) => item.artboardId === artboard.id);
  return Boolean(network && network.nodeIds.length === 0 && network.pathIds.length === 0 &&
    object.id === `${network.id}:object` && object.name === 'Vector Network 1' &&
    !object.appearanceRuleId && !document.geometryComponentForObject(object.id) &&
    object.transform.x === 0 && object.transform.y === 0 && object.transform.rotation === 0 &&
    object.transform.scaleX === 1 && object.transform.scaleY === 1 &&
    appearance?.fills.length === 0 && appearance.opacity === 1 &&
    appearance.stroke?.color === '#c8ced9' && appearance.stroke.width === 1.25 &&
    appearance.stroke.visible && appearance.stroke.opacity === 1 && appearance.stroke.dash.length === 0 &&
    appearance.stroke.cap === 'round' && appearance.stroke.join === 'round' && appearance.stroke.alignment === 'center' &&
    layer?.id === `${network.id}:object-layer` && layer.name === 'Vector Network 1' &&
    layer.visible && !layer.locked && layer.parentId === root?.id &&
    root?.name === 'Layer 1' && root.visible && !root.locked && layers.length === 2 &&
    artboard.layerIds.length === 1 && artboard.layerIds[0] === root.id &&
    root.childIds.length === 1 && root.childIds[0] === layer.id);
}

export function drawnObjectCount(document: VectorDocument): number {
  return [...document.objects.values()].filter((object) => isDrawnObject(document, object)).length;
}
