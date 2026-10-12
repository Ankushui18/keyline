import type { VectorDocument } from './document';
import { objectBounds } from './object-geometry';
import type { EntityId } from './types';
import { drawnObjectsForArtboard, realArtboards } from './real-content';

export type ConsistencyCheckId = 'width' | 'ends' | 'safe-area' | 'grid' | 'small';

export interface ConsistencyCheck {
  id: ConsistencyCheckId;
  label: string;
  passed: boolean;
  /** Short status for the right-hand side, e.g. "All pass" or "2 differ". */
  status: string;
  /** Objects that fail the check. */
  objectIds: EntityId[];
  /** True when "Fix" can repair it automatically. */
  fixable: boolean;
}

export interface ConsistencyTarget {
  strokeWidth: number;
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
}

export interface ConsistencyReport {
  iconCount: number;
  objectCount: number;
  checks: ConsistencyCheck[];
  /** The most common style, which "Fix" sets everything to. Null when nothing has a stroke. */
  target: ConsistencyTarget | null;
  fixObjectIds: EntityId[];
}

const ICON_MAX_SIZE = 128;
const MIN_SCREEN_STROKE_AT_16 = 0.75;

function mostCommon<T extends string | number>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const onHalfPixel = (value: number) => Math.abs(value * 2 - Math.round(value * 2)) <= 0.1;

export function analyzeConsistency(document: VectorDocument): ConsistencyReport {
  const artboards = realArtboards(document);
  const entries = artboards.flatMap((artboard) => drawnObjectsForArtboard(document, artboard.id).map((object) => ({ artboard, object })));
  const stroked = entries.flatMap((entry) => {
    const stroke = document.getAppearance(entry.object.appearanceId)?.stroke;
    return stroke && stroke.visible ? [{ ...entry, stroke }] : [];
  });

  const targetWidth = mostCommon(stroked.map((entry) => round2(entry.stroke.width)));
  const targetEnds = mostCommon(stroked.map((entry) => `${entry.stroke.cap}/${entry.stroke.join}`));
  const widthOffenders = stroked.filter((entry) => targetWidth !== undefined && round2(entry.stroke.width) !== targetWidth).map((entry) => entry.object.id);
  const endOffenders = stroked.filter((entry) => `${entry.stroke.cap}/${entry.stroke.join}` !== targetEnds).map((entry) => entry.object.id);

  const iconEntries = entries.filter(({ artboard }) => Math.max(artboard.frame.width, artboard.frame.height) <= ICON_MAX_SIZE);
  const safeAreaOffenders: EntityId[] = [];
  const gridOffenders: EntityId[] = [];
  for (const { artboard, object } of iconEntries) {
    const frame = artboard.frame;
    const padding = Math.max(0.5, Math.min(frame.width, frame.height) / 12);
    const bounds = objectBounds(document, object.id);
    if (!Number.isFinite(bounds.minX)) continue;
    if (
      bounds.minX < frame.x + padding - 0.01 || bounds.minY < frame.y + padding - 0.01 ||
      bounds.maxX > frame.x + frame.width - padding + 0.01 || bounds.maxY > frame.y + frame.height - padding + 0.01
    ) safeAreaOffenders.push(object.id);
    if (![bounds.minX - frame.x, bounds.minY - frame.y, bounds.maxX - frame.x, bounds.maxY - frame.y].every(onHalfPixel)) gridOffenders.push(object.id);
  }

  const smallOffenders = stroked
    .filter(({ artboard }) => Math.max(artboard.frame.width, artboard.frame.height) <= ICON_MAX_SIZE)
    .filter(({ artboard, stroke }) => stroke.width * 16 / Math.max(artboard.frame.width, artboard.frame.height) < MIN_SCREEN_STROKE_AT_16)
    .map((entry) => entry.object.id);

  const simple = (offenders: EntityId[], singular: string, plural_: string) =>
    offenders.length === 0 ? 'All pass' : `${offenders.length} ${offenders.length === 1 ? singular : plural_}`;

  const checks: ConsistencyCheck[] = [
    {
      id: 'width',
      label: targetWidth === undefined ? 'Line width' : `Line width ${targetWidth} px`,
      passed: widthOffenders.length === 0,
      status: simple(widthOffenders, 'differs', 'differ'),
      objectIds: widthOffenders,
      fixable: true,
    },
    {
      id: 'ends',
      label: targetEnds ? `${targetEnds.split('/')[0][0].toUpperCase()}${targetEnds.split('/')[0].slice(1)} caps, ${targetEnds.split('/')[1]} joins` : 'Caps and joins',
      passed: endOffenders.length === 0,
      status: simple(endOffenders, 'differs', 'differ'),
      objectIds: endOffenders,
      fixable: true,
    },
    {
      id: 'safe-area',
      label: 'Inside the safe area',
      passed: safeAreaOffenders.length === 0,
      status: simple(safeAreaOffenders, 'too close to the edge', 'too close to the edge'),
      objectIds: safeAreaOffenders,
      fixable: false,
    },
    {
      id: 'grid',
      label: 'Edges sit on the pixel grid',
      passed: gridOffenders.length === 0,
      status: simple(gridOffenders, 'is off the grid', 'are off the grid'),
      objectIds: gridOffenders,
      fixable: false,
    },
    {
      id: 'small',
      label: 'Lines stay visible at 16 px',
      passed: smallOffenders.length === 0,
      status: simple(smallOffenders, 'is too thin', 'are too thin'),
      objectIds: smallOffenders,
      fixable: false,
    },
  ];

  const target: ConsistencyTarget | null = targetWidth !== undefined && targetEnds
    ? { strokeWidth: targetWidth, cap: targetEnds.split('/')[0] as ConsistencyTarget['cap'], join: targetEnds.split('/')[1] as ConsistencyTarget['join'] }
    : null;

  return {
    iconCount: artboards.length,
    objectCount: entries.length,
    checks,
    target,
    fixObjectIds: [...new Set([...widthOffenders, ...endOffenders])],
  };
}
