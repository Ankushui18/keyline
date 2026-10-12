import type {
  Artboard,
  DeliveryExportFormat,
  DeliveryPngScale,
  ExportDeliverySettings,
} from '../core/types';

export const DEFAULT_DELIVERY_SETTINGS: ExportDeliverySettings = {
  boundsMode: 'artboard',
  includeBackground: false,
  formats: ['svg'],
  pngScales: [1],
  namingPattern: '{name}-{scale}.{format}',
  includeManifest: false,
};

export interface DeliveryTarget {
  artboardId: string;
  artboardName: string;
  format: DeliveryExportFormat;
  scale?: DeliveryPngScale;
  customSize?: { width: number; height: number };
  filename: string;
}

export interface DeliveryPlan {
  targets: DeliveryTarget[];
  collisions: string[];
}

export interface ZipFileInput {
  filename: string;
  data: string | Blob | Uint8Array | ArrayBuffer;
}

export function cloneDeliverySettings(settings: ExportDeliverySettings): ExportDeliverySettings {
  return {
    ...settings,
    formats: [...settings.formats],
    pngScales: [...settings.pngScales],
    customSize: settings.customSize ? { ...settings.customSize } : undefined,
  };
}

export function normalizeDeliverySettings(
  settings: ExportDeliverySettings | undefined,
): ExportDeliverySettings {
  if (!settings) return cloneDeliverySettings(DEFAULT_DELIVERY_SETTINGS);
  const formats = [...new Set(settings.formats.filter((format): format is DeliveryExportFormat =>
    format === 'svg' || format === 'png'))];
  const pngScales = [...new Set(settings.pngScales.filter((scale): scale is DeliveryPngScale =>
    scale === 1 || scale === 2 || scale === 3))].sort((a, b) => a - b);
  const customSize = settings.customSize &&
    Number.isFinite(settings.customSize.width) && settings.customSize.width > 0 &&
    Number.isFinite(settings.customSize.height) && settings.customSize.height > 0
    ? {
        width: Math.round(settings.customSize.width),
        height: Math.round(settings.customSize.height),
      }
    : undefined;
  return {
    boundsMode: settings.boundsMode === 'artwork' ? 'artwork' : 'artboard',
    includeBackground: Boolean(settings.includeBackground),
    formats: formats.length > 0 ? formats : ['svg'],
    pngScales: pngScales.length > 0 || customSize ? pngScales : [1],
    customSize,
    namingPattern: normalizePattern(settings.namingPattern),
    includeManifest: Boolean(settings.includeManifest),
  };
}

export function planDeliveryExports(
  artboards: Artboard[],
  settingsInput: ExportDeliverySettings,
): DeliveryPlan {
  const settings = normalizeDeliverySettings(settingsInput);
  const targets: DeliveryTarget[] = [];
  for (const artboard of artboards) {
    if (artboard.isCanvasRoot) continue;
    if (settings.formats.includes('svg')) {
      targets.push({
        artboardId: artboard.id,
        artboardName: artboard.name,
        format: 'svg',
        filename: deliveryFilename(settings.namingPattern, {
          name: artboard.name,
          format: 'svg',
          scale: '',
        }),
      });
    }
    if (settings.formats.includes('png')) {
      for (const scale of settings.pngScales) {
        targets.push({
          artboardId: artboard.id,
          artboardName: artboard.name,
          format: 'png',
          scale,
          filename: deliveryFilename(settings.namingPattern, {
            name: artboard.name,
            format: 'png',
            scale: `${scale}x`,
          }),
        });
      }
      if (settings.customSize) {
        const customSize = { ...settings.customSize };
        targets.push({
          artboardId: artboard.id,
          artboardName: artboard.name,
          format: 'png',
          customSize,
          filename: deliveryFilename(settings.namingPattern, {
            name: artboard.name,
            format: 'png',
            scale: `${customSize.width}x${customSize.height}`,
          }),
        });
      }
    }
  }

  const counts = new Map<string, number>();
  for (const target of targets) {
    const key = target.filename.toLocaleLowerCase('en-US');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const collisions = [...counts]
    .filter(([, count]) => count > 1)
    .map(([filename]) => targets.find((target) => target.filename.toLocaleLowerCase('en-US') === filename)!.filename)
    .sort((a, b) => a.localeCompare(b));
  return { targets, collisions };
}

export function deliveryFilename(
  pattern: string,
  values: { name: string; scale: string; format: DeliveryExportFormat },
): string {
  const normalized = normalizePattern(pattern);
  let filename = normalized
    .replaceAll('{name}', slugify(values.name))
    .replaceAll('{scale}', values.scale)
    .replaceAll('{format}', values.format)
    .replace(/[\\/\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[-_@]+(?=\.)/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  if (!filename.toLowerCase().endsWith(`.${values.format}`)) filename = `${filename}.${values.format}`;
  return filename || `asset.${values.format}`;
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'asset';
}

export function archiveFilename(artboards: Artboard[]): string {
  if (artboards.length === 1) return `${slugify(artboards[0].name)}-delivery.zip`;
  return 'vector-assets-delivery.zip';
}

/** JSZip stays behind a dynamic import so it never enters the application entry chunk. */
export async function createZipBlob(files: ZipFileInput[]): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const file of files) zip.file(file.filename, file.data);
  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function normalizePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) return DEFAULT_DELIVERY_SETTINGS.namingPattern;
  const withName = trimmed.includes('{name}') ? trimmed : `{name}-${trimmed}`;
  return withName.includes('{format}') ? withName : `${withName}.{format}`;
}
