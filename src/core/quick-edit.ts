/**
 * "Ask for an edit": a small, deterministic phrase reader for common appearance edits.
 * It runs entirely on this device, needs no AI model, and never guesses: a phrase it
 * cannot read gets an honest message with examples instead of a wrong change.
 */

import { NAMED_COLORS } from '../design-system/document-defaults';

export interface AppearanceUpdates {
  opacity?: number;
  strokeWidth?: number;
  strokeVisible?: boolean;
  strokeAlignment?: 'center' | 'inside' | 'outside';
  strokeCap?: 'butt' | 'round' | 'square';
  strokeJoin?: 'miter' | 'round' | 'bevel';
  strokeColor?: string;
  fillColor?: string;
  fillRemoved?: boolean;
}

export interface QuickEditTarget {
  id: string;
  strokeWidth?: number;
  strokeCap?: 'butt' | 'round' | 'square';
  strokeJoin?: 'miter' | 'round' | 'bevel';
  strokeColor?: string;
  fillColor?: string;
}

export interface QuickEditChange {
  label: string;
  before: string;
  after: string;
}

export interface QuickEditPlan {
  ok: true;
  changes: QuickEditChange[];
  steps: Array<{ objectIds: string[]; updates: AppearanceUpdates }>;
}

export interface QuickEditFailure {
  ok: false;
  message: string;
}

export const QUICK_EDIT_EXAMPLES = ['thinner', 'line 1.5', 'round ends', 'sharp corners', 'no fill', 'line color black'];

const COLORS = NAMED_COLORS;
const MIN_WIDTH = 0.25;
const WIDTH_STEP = 0.25;

function parseColor(text: string): string | undefined {
  const hex = text.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (hex) {
    const raw = hex[1].toLowerCase();
    return `#${raw.length === 3 ? raw.split('').map((char) => char + char).join('') : raw}`;
  }
  const name = Object.keys(COLORS).find((key) => new RegExp(`\\b${key}\\b`).test(text));
  return name ? COLORS[name] : undefined;
}

const formatWidth = (value: number) => `${Math.round(value * 100) / 100} px`;

function snapWidth(value: number, direction: 'down' | 'up', previous: number): number {
  let next = Math.max(MIN_WIDTH, Math.round(value / WIDTH_STEP) * WIDTH_STEP);
  if (Math.abs(next - previous) < 1e-9) next = Math.max(MIN_WIDTH, previous + (direction === 'up' ? WIDTH_STEP : -WIDTH_STEP));
  return next;
}

export function planQuickEdit(input: string, targets: QuickEditTarget[]): QuickEditPlan | QuickEditFailure {
  const text = input.toLowerCase().trim();
  if (!text) return { ok: false, message: `Describe the change, for example “${QUICK_EDIT_EXAMPLES[0]}” or “${QUICK_EDIT_EXAMPLES[1]}”.` };
  if (targets.length === 0) return { ok: false, message: 'Select a shape first, then ask for the change.' };

  const changes: QuickEditChange[] = [];
  const perObject = new Map<string, AppearanceUpdates>();
  const set = (id: string, updates: AppearanceUpdates) => perObject.set(id, { ...perObject.get(id), ...updates });
  const summarize = (values: Array<string | undefined>) => {
    const unique = [...new Set(values.filter((value): value is string => value !== undefined))];
    return unique.length === 0 ? 'none' : unique.length === 1 ? unique[0] : 'mixed';
  };

  // Line width: exact number first, then relative words.
  const exact = text.match(/(?:line|stroke)(?:\s*(?:width|weight))?\s*(?:to|=|of|:)?\s*(\d+(?:\.\d+)?)/) ?? text.match(/(\d+(?:\.\d+)?)\s*(?:px)?\s*(?:line|stroke)/);
  const thinner = /\b(thinner|thin|slimmer|lighter line|finer)\b/.test(text);
  const thicker = /\b(thicker|bolder|heavier|thick|bold)\b/.test(text);
  const withStroke = targets.filter((target) => target.strokeWidth !== undefined);
  if (exact || thinner || thicker) {
    if (withStroke.length === 0) return { ok: false, message: 'The selection has no line to change. Turn a line on in Design first.' };
    const before = summarize(withStroke.map((target) => formatWidth(target.strokeWidth!)));
    const widths: string[] = [];
    for (const target of withStroke) {
      const old = target.strokeWidth!;
      const next = exact
        ? Math.max(MIN_WIDTH, Number(exact[1]))
        : thinner ? snapWidth(old * 0.75, 'down', old) : snapWidth(old * 1.25, 'up', old);
      set(target.id, { strokeWidth: next });
      widths.push(formatWidth(next));
    }
    changes.push({ label: 'Line width', before, after: summarize(widths) });
  }

  const caps: Array<[RegExp, 'round' | 'square' | 'butt', string]> = [
    [/\bround(?:ed)?\s+(?:caps?|ends?)\b/, 'round', 'Round'],
    [/\bsquare\s+(?:caps?|ends?)\b/, 'square', 'Square'],
    [/\b(?:flat|butt)\s+(?:caps?|ends?)\b/, 'butt', 'Flat'],
  ];
  for (const [pattern, cap, label] of caps) {
    if (!pattern.test(text)) continue;
    const list = withStroke.length ? withStroke : [];
    if (list.length === 0) return { ok: false, message: 'The selection has no line to change.' };
    list.forEach((target) => set(target.id, { strokeCap: cap }));
    changes.push({ label: 'Line ends', before: summarize(list.map((target) => target.strokeCap)), after: label });
  }

  const joins: Array<[RegExp, 'round' | 'miter' | 'bevel', string]> = [
    [/\bround(?:ed)?\s+(?:joins?|corners?)\b/, 'round', 'Round'],
    [/\b(?:sharp|pointed|mitre|miter)\s*(?:joins?|corners?)?\b/, 'miter', 'Sharp'],
    [/\bbevel(?:led)?\s*(?:joins?|corners?)?\b/, 'bevel', 'Bevel'],
  ];
  for (const [pattern, join, label] of joins) {
    if (!pattern.test(text)) continue;
    if (withStroke.length === 0) return { ok: false, message: 'The selection has no line to change.' };
    withStroke.forEach((target) => set(target.id, { strokeJoin: join }));
    changes.push({ label: 'Corners', before: summarize(withStroke.map((target) => target.strokeJoin)), after: label });
    break;
  }

  if (/\b(?:no|remove|without|delete|clear)\s+fill\b/.test(text)) {
    targets.forEach((target) => set(target.id, { fillRemoved: true }));
    changes.push({ label: 'Fill', before: summarize(targets.map((target) => target.fillColor)), after: 'None' });
  } else {
    const fill = text.match(/\bfill(?:ed)?\s*(?:with|to|=|:)?\s*(.+)$/);
    const color = fill ? parseColor(fill[1]) : undefined;
    if (color) {
      targets.forEach((target) => set(target.id, { fillColor: color }));
      changes.push({ label: 'Fill', before: summarize(targets.map((target) => target.fillColor)), after: color });
    }
  }

  const lineColor = text.match(/\b(?:line|stroke|outline)\s*(?:colou?r)?\s*(?:to|=|:)?\s*(.+?)(?:\band\b|,|$)/);
  const strokeColor = lineColor ? parseColor(lineColor[1]) : undefined;
  if (strokeColor && !exact) {
    if (withStroke.length === 0) return { ok: false, message: 'The selection has no line to recolor.' };
    withStroke.forEach((target) => set(target.id, { strokeColor }));
    changes.push({ label: 'Line color', before: summarize(withStroke.map((target) => target.strokeColor)), after: strokeColor });
  }

  if (changes.length === 0) {
    return { ok: false, message: `I can change line width, ends, corners, fill and color. Try “${QUICK_EDIT_EXAMPLES.slice(0, 3).join('”, “')}”.` };
  }

  // Group objects that receive identical updates so each group is one operation.
  const groups = new Map<string, { objectIds: string[]; updates: AppearanceUpdates }>();
  for (const [id, updates] of perObject) {
    const key = JSON.stringify(updates);
    const group = groups.get(key) ?? { objectIds: [], updates };
    group.objectIds.push(id);
    groups.set(key, group);
  }
  return { ok: true, changes, steps: [...groups.values()] };
}
