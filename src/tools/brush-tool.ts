import type { VectorDocument } from '../core/document';
import type { DrawingStyle, Point } from '../core/types';
import { preparePencilObject, type PencilPlan } from './pencil-tool';

export interface BrushSample {
  point: Point;
  pressure: number;
}

/** Builds an expressive pressure-aware freehand path using normal Typed Graph segments and width profiles. */
export function prepareBrushObject(
  document: VectorDocument,
  samples: BrushSample[],
  style: DrawingStyle,
): PencilPlan | null {
  if (samples.length < 2) return null;
  const points = samples.map((sample) => sample.point);
  const widths = samples.map((sample, index) => {
    const pressure = Number.isFinite(sample.pressure) && sample.pressure > 0
      ? Math.max(0, Math.min(1, sample.pressure))
      : 0.5;
    const pressureScale = 0.3 + pressure * 1.4;
    const endpointTaper = index === 0 || index === samples.length - 1 ? 0.38 : 1;
    return Math.max(0.5, style.strokeWidth * pressureScale * endpointTaper);
  });
  return preparePencilObject(document, points, style, {
    namePrefix: 'Brush',
    widths,
  });
}
