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

/** Artboards the person can see as real frames: not the hidden canvas root, and not an empty starter frame next to real ones. */
export function realArtboards(document: VectorDocument): Artboard[] {
  const all = [...document.artboards.values()].filter((artboard) => !artboard.isCanvasRoot);
  const filled = all.filter((artboard) => drawnObjectsForArtboard(document, artboard.id).length > 0);
  if (filled.length === 0) return all.slice(0, 1);
  return all.filter((artboard) => filled.includes(artboard) || artboard.name !== 'Artboard 1');
}

export function drawnObjectCount(document: VectorDocument): number {
  return [...document.objects.values()].filter((object) => isDrawnObject(document, object)).length;
}
