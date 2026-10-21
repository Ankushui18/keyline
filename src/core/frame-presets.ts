/**
 * Every frame size the editor offers, in one place — §3.7 of docs/EDITING-AUDIT.md.
 *
 * The toolbar, the dashboard and the in-canvas start overlay all read this list, so a
 * preset cannot exist in one entry point and be missing from another. Sizes are in CSS
 * pixels; the print presets are pixels at 96 dpi, because the document model has no
 * physical units and pretending otherwise would be a lie in the label.
 */
export type FrameGroup = 'Interface' | 'Web' | 'Device' | 'Social' | 'Print' | 'Artwork';

export interface FramePreset {
  id: string;
  group: FrameGroup;
  label: string;
  width: number;
  height: number;
  /**
   * The frame name this preset creates. Icon presets leave it unset so frames keep the
   * `Icon N` naming the icon workflow and its regression suite expect.
   */
  name?: string;
}

export const FRAME_PRESETS: readonly FramePreset[] = [
  { id: 'icon-24', group: 'Interface', label: 'Interface icon', width: 24, height: 24 },
  { id: 'icon-32', group: 'Interface', label: 'Product icon', width: 32, height: 32 },
  { id: 'icon-48', group: 'Interface', label: 'Large icon', width: 48, height: 48 },
  { id: 'web-1440', group: 'Web', label: 'Web page', width: 1440, height: 1024, name: 'Web page' },
  { id: 'web-1280', group: 'Web', label: 'Desktop', width: 1280, height: 800, name: 'Desktop' },
  { id: 'device-phone', group: 'Device', label: 'Phone', width: 390, height: 844, name: 'Phone' },
  { id: 'device-tablet', group: 'Device', label: 'Tablet', width: 768, height: 1024, name: 'Tablet' },
  { id: 'social-square', group: 'Social', label: 'Social post', width: 1080, height: 1080, name: 'Social post' },
  { id: 'social-link', group: 'Social', label: 'Link preview', width: 1200, height: 630, name: 'Link preview' },
  { id: 'print-a4', group: 'Print', label: 'A4 · 96 dpi', width: 794, height: 1123, name: 'A4' },
  { id: 'print-letter', group: 'Print', label: 'Letter · 96 dpi', width: 816, height: 1056, name: 'Letter' },
  { id: 'art-square', group: 'Artwork', label: 'Illustration', width: 1000, height: 1000, name: 'Illustration' },
  { id: 'art-slide', group: 'Artwork', label: 'Presentation', width: 1920, height: 1080, name: 'Presentation' },
];

/** Groups in menu order, each with its presets. */
export function framePresetGroups(presets: readonly FramePreset[] = FRAME_PRESETS): Array<{ group: FrameGroup; presets: FramePreset[] }> {
  const order: FrameGroup[] = ['Interface', 'Web', 'Device', 'Social', 'Print', 'Artwork'];
  return order
    .map((group) => ({ group, presets: presets.filter((preset) => preset.group === group) }))
    .filter((entry) => entry.presets.length > 0);
}

export function framePreset(id: string): FramePreset | undefined {
  return FRAME_PRESETS.find((preset) => preset.id === id);
}

/** `1440 × 1024` — the one place size text is formatted for the interface. */
export function framePresetSize(preset: Pick<FramePreset, 'width' | 'height'>): string {
  return `${preset.width} × ${preset.height}`;
}

/** The icon start, kept separate because it also seeds the icon drawing style. */
export const ICON_PRESET_IDS = ['icon-24', 'icon-32', 'icon-48'] as const;

export function isIconPreset(preset: FramePreset): boolean {
  return preset.group === 'Interface';
}
