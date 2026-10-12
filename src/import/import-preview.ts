import { prepareCreateIconArtboard } from '../core/artboard-operations';
import { preparePasteObjects, type VectorClipboardPayload } from '../core/clipboard';
import { VectorDocument } from '../core/document';
import { OperationManager } from '../core/operations';
import { exportDocumentToSvg } from '../export/svg-export';

interface Viewport { minX: number; minY: number; width: number; height: number }

/** Places imported objects on a fresh icon frame. Shared by the real import and the dialog previews. */
export function placeImportedPayload(
  document: VectorDocument,
  manager: OperationManager,
  payload: VectorClipboardPayload,
  viewport: Viewport,
) {
  const framePlan = prepareCreateIconArtboard(document, viewport.width, viewport.height);
  payload.objects.forEach((item) => {
    item.object.transform.x = framePlan.artboard.frame.x - viewport.minX;
    item.object.transform.y = framePlan.artboard.frame.y - viewport.minY;
  });
  manager.beginTransaction('Import SVG');
  framePlan.operations.forEach((operation) => manager.execute(operation));
  const objectPlan = payload.objects.length > 0
    ? preparePasteObjects(document, payload, { offset: { x: 0, y: 0 }, preserveNames: true })
    : null;
  objectPlan?.operations.forEach((operation) => manager.execute(operation));
  manager.commitTransaction();
  return { framePlan, objectPlan };
}

/** Renders what an import would look like as an SVG string, without touching the open file. */
export function renderImportPreview(payload: VectorClipboardPayload, viewport: Viewport): string | undefined {
  try {
    const document = VectorDocument.createEmpty();
    const manager = new OperationManager(document);
    const { framePlan } = placeImportedPayload(document, manager, structuredClone(payload), viewport);
    return exportDocumentToSvg(document, {
      artboardId: framePlan.artboard.id,
      exportBoundsMode: 'artboard',
      includeMetadata: false,
    });
  } catch {
    return undefined;
  }
}
