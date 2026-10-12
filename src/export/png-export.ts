import type { VectorDocument } from '../core/document';
import type { DeliveryExportBoundsMode, EntityId } from '../core/types';
import { exportDocumentToSvg } from './svg-export';

export const MAX_CANVAS_DIMENSION = 16_384;
export const MAX_CANVAS_AREA = 268_435_456;

export interface RasterSize {
  width: number;
  height: number;
}

export type RasterSizeRequest =
  | { scale: number; customSize?: never }
  | { customSize: RasterSize; scale?: never };

export type PngExportOptions = RasterSizeRequest & {
  artboardId: EntityId;
  boundsMode: DeliveryExportBoundsMode;
  includeBackground: boolean;
};

export class CanvasExportLimitError extends Error {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly maxDimension = MAX_CANVAS_DIMENSION,
    readonly maxArea = MAX_CANVAS_AREA,
  ) {
    super(
      `PNG size ${width.toLocaleString()}×${height.toLocaleString()} px exceeds the safe browser canvas limit. ` +
      `Use a smaller scale or custom size (maximum ${maxDimension.toLocaleString()} px per side and ` +
      `${maxArea.toLocaleString()} total pixels).`,
    );
    this.name = 'CanvasExportLimitError';
  }
}

export function calculateRasterSize(
  source: RasterSize,
  request: RasterSizeRequest,
): RasterSize {
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) {
    throw new Error('Export source dimensions must be finite values greater than 0.');
  }
  const raw = request.customSize
    ? request.customSize
    : { width: source.width * request.scale, height: source.height * request.scale };
  if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0 || raw.height <= 0) {
    throw new Error('PNG dimensions must be finite values greater than 0.');
  }
  return { width: Math.max(1, Math.round(raw.width)), height: Math.max(1, Math.round(raw.height)) };
}

export function validateCanvasSize(
  size: RasterSize,
  limits: { maxDimension?: number; maxArea?: number } = {},
): void {
  const maxDimension = limits.maxDimension ?? MAX_CANVAS_DIMENSION;
  const maxArea = limits.maxArea ?? MAX_CANVAS_AREA;
  if (size.width > maxDimension || size.height > maxDimension || size.width * size.height > maxArea) {
    throw new CanvasExportLimitError(size.width, size.height, maxDimension, maxArea);
  }
}

export function svgViewportSize(svg: string): RasterSize {
  const match = svg.match(/\bviewBox="[^\s"]+\s+[^\s"]+\s+([^\s"]+)\s+([^\s"]+)"/);
  if (!match) throw new Error('The evaluated SVG does not contain a valid viewBox.');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('The evaluated SVG has invalid dimensions.');
  }
  return { width, height };
}

/**
 * Rasterizes the same metadata-free SVG scene used for production vector export.
 * The detached canvas never receives editor overlays, selection, grids, or guides.
 */
export async function exportArtboardToPngBlob(
  documentModel: VectorDocument,
  options: PngExportOptions,
): Promise<{ blob: Blob; size: RasterSize; svg: string }> {
  const artboard = documentModel.getArtboard(options.artboardId);
  if (!artboard || artboard.isCanvasRoot) throw new Error('The selected artboard is no longer available.');
  const svg = exportDocumentToSvg(documentModel, {
    artboardId: artboard.id,
    exportBoundsMode: options.boundsMode,
    backgroundColor: options.includeBackground ? artboard.background : undefined,
    includeMetadata: false,
  });
  const size = calculateRasterSize(svgViewportSize(svg), options.customSize
    ? { customSize: options.customSize }
    : { scale: options.scale });
  validateCanvasSize(size);
  const blob = await rasterizeSvgToPng(svg, size);
  return { blob, size, svg };
}

export async function rasterizeSvgToPng(svg: string, size: RasterSize): Promise<Blob> {
  validateCanvasSize(size);
  const canvas = window.document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PNG export is unavailable because this browser could not create a 2D canvas.');
  const image = await loadSvgImage(svg);
  try {
    context.clearRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    return await canvasToBlob(canvas);
  } finally {
    image.removeAttribute('src');
  }
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const image = new Image();
    const release = () => URL.revokeObjectURL(url);
    image.onload = () => {
      release();
      resolve(image);
    };
    image.onerror = () => {
      release();
      reject(new Error('The evaluated vector scene could not be rasterized by this browser.'));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode the rasterized scene as PNG.'));
    }, 'image/png');
  });
}
