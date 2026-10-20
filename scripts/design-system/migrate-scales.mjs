#!/usr/bin/env node
/**
 * Bring typography, radius and layering onto the design-system scales.
 *
 * Colours were the first migration (`migrate-colors.mjs`). This one does the
 * dimensions you *see* but never named: the 20 distinct font sizes, the 15
 * border radii and the 36 z-index values that made two panels built a month
 * apart sit a pixel or two off each other.
 *
 * What it changes:
 *   font-size     → var(--font-size-*)      nearest step on the type scale
 *   font-family   → var(--font-sans|mono)   no literal Geist stacks
 *   border-radius → var(--radius-*)         nearest step on the radius scale
 *   z-index       → var(--z-*)              nearest tier, monotonic per file
 *
 * The z-index mapping is monotonic *within each stylesheet*: a value that sat
 * above another still sits above it afterwards, so no stacking order inside a
 * component can change. Local layers 0–9 are left alone on purpose.
 *
 * Usage:
 *   node scripts/design-system/migrate-scales.mjs [--report] [--all]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stylesDir = join(root, 'src/styles');
const SYSTEM_DIR = join(stylesDir, 'system');

const reportOnly = process.argv.includes('--report');
const scope = process.argv.includes('--all')
  ? readdirSync(stylesDir).filter((f) => f.endsWith('.css')).map((f) => join(stylesDir, f))
  : [];

const tokensCss = readFileSync(join(SYSTEM_DIR, 'tokens.css'), 'utf8');
function scale(prefix) {
  const values = new Map();
  for (const match of tokensCss.matchAll(new RegExp(`^\\s*(--${prefix}[a-z0-9-]*)\\s*:\\s*([0-9.]+)px`, 'gim'))) {
    values.set(match[1], Number(match[2]));
  }
  return values;
}

const TYPE = scale('font-size-');
const RADIUS = scale('radius-');

/** z-index tiers are unitless, so they need their own reader. */
function unitlessScale(prefix) {
  const values = new Map();
  for (const match of tokensCss.matchAll(new RegExp(`^\\s*(--${prefix}[a-z0-9-]*)\\s*:\\s*([0-9]+)\\s*;`, 'gim'))) {
    values.set(match[1], Number(match[2]));
  }
  return values;
}
const Z = unitlessScale('z-');

/** Line heights are unitless ratios in tokens.css. */
function ratioScale(prefix) {
  const values = new Map();
  for (const match of tokensCss.matchAll(new RegExp(`^\\s*(--${prefix}[a-z0-9-]*)\\s*:\\s*([0-9.]+)\\s*;`, 'gim'))) {
    values.set(match[1], Number(match[2]));
  }
  return values;
}
const LINE_HEIGHT = ratioScale('line-height-');

/** Nearest scale step; ties resolve to the smaller step so text never grows. */
function nearest(scaleMap, value) {
  let best;
  for (const [name, step] of scaleMap) {
    const distance = Math.abs(step - value);
    if (!best || distance < best.distance || (distance === best.distance && step < best.step)) {
      best = { name, step, distance };
    }
  }
  return best;
}

/**
 * Assign z-index tiers that are strictly increasing in the order the file
 * already uses them, so relative stacking is preserved.
 */
function mapZIndex(fileSource) {
  const values = [...new Set([...fileSource.matchAll(/z-index:\s*(-?\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value >= 10))].sort((a, b) => a - b);
  if (!values.length) return new Map();
  const tiers = [...Z.entries()].map(([name, step]) => ({ name, step })).sort((a, b) => a.step - b.step);
  const assignment = new Map();
  let floor = -Infinity;
  for (const value of values) {
    const candidate = tiers
      .filter((tier) => tier.step > floor)
      .reduce((best, tier) => {
        const distance = Math.abs(tier.step - value);
        return !best || distance < best.distance ? { ...tier, distance } : best;
      }, undefined);
    if (!candidate) continue;
    assignment.set(value, candidate.name);
    floor = candidate.step;
  }
  return assignment;
}

const counters = { fontSize: 0, fontFamily: 0, radius: 0, zIndex: 0, lineHeight: 0 };
const notes = [];

for (const file of scope) {
  if (file.startsWith(SYSTEM_DIR)) continue;
  const before = readFileSync(file, 'utf8');
  let out = before;

  out = out.replace(/font-size:\s*([0-9.]+)px/g, (whole, raw) => {
    const value = Number(raw);
    const match = nearest(TYPE, value);
    if (!match) return whole;
    counters.fontSize += 1;
    if (match.step !== value) notes.push(`${relative(root, file)}: font-size ${value}px → ${match.name} (${match.step}px)`);
    return `font-size: var(${match.name})`;
  });

  // Shorthand first: `font: 600 13px/1.4 'Geist', system-ui, sans-serif`.
  out = out.replace(/font:\s*([^;{}]*?)'(Geist Mono|Geist)'[^;{}]*/g, (whole, head, family) => {
    counters.fontFamily += 1;
    const token = family === 'Geist Mono' ? '--font-mono' : '--font-sans';
    return `font: ${head.trimEnd()} var(${token})`;
  });
  out = out.replace(/font-family:\s*'Geist Mono'[^;{}]*/g, () => {
    counters.fontFamily += 1;
    return 'font-family: var(--font-mono)';
  });
  out = out.replace(/font-family:\s*'Geist'[^;{}]*/g, () => {
    counters.fontFamily += 1;
    return 'font-family: var(--font-sans)';
  });

  out = out.replace(/border-radius:\s*([^;{}]+)/g, (whole, value) => {
    if (!/[0-9.]+px/.test(value)) return whole;
    const rewritten = value.replace(/([0-9.]+)px/g, (_, raw) => {
      const match = nearest(RADIUS, Number(raw));
      if (!match) return `${raw}px`;
      counters.radius += 1;
      if (match.step !== Number(raw)) notes.push(`${relative(root, file)}: border-radius ${raw}px → ${match.name} (${match.step}px)`);
      return `var(${match.name})`;
    });
    return `border-radius: ${rewritten}`;
  });

  out = out.replace(/(^|[;{\s])line-height:\s*([0-9.]+)(?=\s*[;}])/g, (whole, lead, raw) => {
    // `line-height: 1` is a deliberate single-line lock, not a scale step.
    const value = Number(raw);
    if (value < 1.2) return whole;
    const match = nearest(LINE_HEIGHT, value);
    if (!match) return whole;
    counters.lineHeight += 1;
    if (match.step !== Number(raw)) notes.push(`${relative(root, file)}: line-height ${raw} → ${match.name} (${match.step})`);
    return `${lead}line-height: var(${match.name})`;
  });

  const zMap = mapZIndex(out);
  out = out.replace(/z-index:\s*(-?\d+)/g, (whole, raw) => {
    const value = Number(raw);
    if (value < 10) return whole;
    const token = zMap.get(value);
    if (!token) return whole;
    counters.zIndex += 1;
    return `z-index: var(${token})`;
  });

  if (out !== before && !reportOnly) writeFileSync(file, out);
  if (out !== before) console.log(`${relative(root, file).padEnd(34)} ${reportOnly ? 'would change' : 'updated'}`);
}

console.log(`\nfont-size ${counters.fontSize} · font-family ${counters.fontFamily} · radius ${counters.radius} · z-index ${counters.zIndex} · line-height ${counters.lineHeight}${reportOnly ? ' (report only)' : ''}`);
if (process.argv.includes('--details')) {
  console.log('\nApproximated values (closest scale step):');
  for (const note of notes) console.log(`  ${note}`);
}
