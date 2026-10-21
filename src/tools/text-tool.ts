import type { VectorDocument } from '../core/document';
import { DEFAULT_DRAWING_INK } from '../design-system/document-defaults';
import { prepareArtboardPlacement } from '../core/artboard-operations';
import { createEntityId } from '../core/ids';
import { DEFAULT_TEXT, normalizeTextContent, textLocalBounds } from '../core/text';
import type { OperationInput } from '../core/operations';
import type { Appearance, EntityId, LayerNode, NetworkObject, Point, TextContent } from '../core/types';

export interface TextPlan {
  objectId: EntityId;
  layerId: EntityId;
  networkId: EntityId;
  name: string;
  operations: OperationInput[];
}

export interface TextOptions {
  /** Partial style: missing fields come from `DEFAULT_TEXT`. */
  text?: Partial<TextContent>;
  /** Ink for the text. Defaults to the drawing ink in the design system. */
  color?: string;
}

/**
 * A text object as an operation plan (docs/EDITING-AUDIT.md §3.9). Text is an ordinary
 * `NetworkObject` with an empty network and a `text` field, so every existing path — layers,
 * selection, transform, undo, clipboard, snapshot — applies without a special case.
 */
export function prepareTextObject(
  document: VectorDocument,
  origin: Point,
  options: TextOptions = {},
): TextPlan {
  const text = normalizeTextContent({ ...DEFAULT_TEXT, ...options.text }) ?? DEFAULT_TEXT;
  const networkId = createEntityId();
  const appearanceId = createEntityId();
  const objectId = createEntityId();
  const layerId = createEntityId();
  const name = textName(text);
  const bounds = textLocalBounds(text);
  const appearance: Appearance = {
    id: appearanceId,
    fills: [{ type: 'solid', color: options.color ?? DEFAULT_DRAWING_INK, opacity: 1, visible: true }],
    opacity: 1,
  };
  const object: NetworkObject = {
    id: objectId,
    name,
    networkId,
    appearanceId,
    transform: { x: origin.x, y: origin.y, rotation: 0, scaleX: 1, scaleY: 1 },
    text,
  };
  const center = { x: origin.x + bounds.width / 2, y: origin.y + bounds.height / 2 };
  const placement = prepareArtboardPlacement(document, center);
  const targetArtboard = document.getArtboard(placement.artboardId);
  const layer: LayerNode = {
    id: layerId, kind: 'object', name, artboardId: placement.artboardId, childIds: [], objectId,
    visible: true, locked: false, expanded: true,
  };
  const operations: OperationInput[] = [
    ...placement.setupOperations,
    { type: 'ADD_NETWORK', payload: { network: { id: networkId, nodeIds: [], pathIds: [] } } },
    { type: 'ADD_APPEARANCE', payload: { appearance } },
    { type: 'ADD_OBJECT', payload: { object } },
    { type: 'ADD_LAYER', payload: { layer, index: targetArtboard?.layerIds.length ?? 0 } },
    ...(placement.artboardId === document.activeArtboardId ? [] : [{
      type: 'SET_ACTIVE_LOCATION' as const,
      payload: { pageId: document.activePageId, artboardId: placement.artboardId },
    }]),
  ];
  return { objectId, layerId, networkId, name, operations };
}

/**
 * The name a new text object gets: its first words, so layers and the Layers panel stay
 * readable without opening the inspector.
 */
export function textName(text: TextContent): string {
  const firstLine = text.content.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) return 'Text';
  return firstLine.length > 28 ? `${firstLine.slice(0, 27)}…` : firstLine;
}
