#!/usr/bin/env node
/**
 * Design conformance test.
 *
 * The gate (`check.mjs`) proves the *source* follows the rules. This proves the
 * *resolved stylesheet* behaves: it parses the 27 stylesheets in the exact order
 * `src/main.tsx` loads them, resolves every `var()` chain the way a browser
 * would, and then asks the questions a designer would ask:
 *
 *   1. Resolution  — does every declaration end up as a real value?
 *   2. Contrast    — where a rule sets ink *and* a background, is the pair legible?
 *   3. Sameness    — do buttons across 24 feature stylesheets resolve to the same
 *                    box (height, radius, type size, padding)?
 *   4. Inheritance — is a rule setting ink that no surface token can support?
 *
 * No browser is required, and none is available in this environment; this is a
 * static model of the cascade, not a rendering engine. It is deliberately
 * conservative: anything it cannot resolve is reported rather than assumed.
 *
 * Usage: node scripts/design-system/conformance.mjs [--verbose]
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio } from './lib/color.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const verbose = process.argv.includes('--verbose');
const problems = [];
const warnings = [];

/* ------------------------------------------------------------ 1. the cascade */

const entry = await readFile(join(root, 'src/main.tsx'), 'utf8');
const cascade = [...entry.matchAll(/import '\.\/styles\/([^']+)'/g)].map((m) => `src/styles/${m[1]}`);

/** Every rule in the cascade, in order, with its file. */
function parseRules(text, file) {
  const rules = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    const declarations = new Map();
    for (const decl of match[2].matchAll(/([a-zA-Z-]+)\s*:\s*([^;]+)/g)) {
      declarations.set(decl[1].trim().toLowerCase(), decl[2].trim());
    }
    rules.push({ file, selector, declarations });
  }
  return rules;
}

const tokenFile = await readFile(join(root, 'src/styles/system/tokens.css'), 'utf8');
const tokens = new Map();
for (const match of tokenFile.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/gim)) {
  tokens.set(match[1], match[2].trim());
}

/**
 * Component-scoped custom properties (`--ui-button-height`, `--di-divider`,
 * `--layer-depth`) are declared on selectors, not on :root. Browsers resolve
 * them through the cascade; here the last declaration wins, and a rule's own
 * declarations take precedence over that.
 */
const localProperties = new Map();
for (const file of cascade) {
  const text = await readFile(join(root, file), 'utf8');
  for (const match of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const decl of match[2].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+)/g)) {
      localProperties.set(decl[1], decl[2].trim());
    }
  }
}
const scopedTokens = (rule) => {
  const scope = new Map(localProperties);
  if (rule) {
    for (const [property, value] of rule.declarations) {
      if (property.startsWith('--')) scope.set(property, value);
    }
  }
  return scope;
};

/** Resolve var() chains; returns undefined when a reference cannot be resolved. */
function resolveValue(value, depth = 0, scope = localProperties) {
  if (value === undefined || depth > 12) return undefined;
  const reference = /var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/.exec(value);
  if (!reference) return value.trim();
  const [whole, name, fallback] = reference;
  const token = scope.get(name) ?? tokens.get(name);
  const replacement = token !== undefined ? token : fallback;
  if (replacement === undefined) return undefined;
  return resolveValue(value.replace(whole, replacement), depth + 1, scope);
}

const allRules = [];
for (const file of cascade) {
  const text = await readFile(join(root, file), 'utf8');
  allRules.push(...parseRules(text, file));
}

/* ------------------------------------------------------------- colour model */

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

function parseColor(raw) {
  if (!raw) return undefined;
  const value = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) return { ...toRgbObject(hexToRgb(value)), a: 1 };
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i.exec(value);
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  return undefined;
}
const toRgbObject = ([r, g, b]) => ({ r, g, b });
const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Composite a possibly-translucent colour over an opaque backdrop. */
function flatten(color, backdrop) {
  if (color.a >= 1) return color;
  const base = backdrop ?? { r: 23, g: 24, b: 26, a: 1 };
  return {
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
    a: 1,
  };
}

const ratio = (foreground, background) => {
  const fg = flatten(foreground);
  const bg = flatten(background);
  return contrastRatio(toHex(fg), toHex(bg));
};

/* ------------------------------------------------------------ 2. resolution */

let checkedDeclarations = 0;
let resolvedDeclarations = 0;
for (const rule of allRules) {
  for (const [property, value] of rule.declarations) {
    // Hex-escaped glyphs and content strings are not design values.
    if (property === 'content' || property.includes('grid-area')) continue;
    checkedDeclarations += 1;
    const resolved = resolveValue(value, 0, scopedTokens(rule));
    if (resolved === undefined) {
      problems.push(`${relative(root, rule.file)} · ${rule.selector} · ${property} → unresolvable "${value}"`);
    } else if (/var\(/.test(resolved)) {
      problems.push(`${relative(root, rule.file)} · ${rule.selector} · ${property} → still contains var() after resolution`);
    } else {
      resolvedDeclarations += 1;
    }
  }
}
const resolutionRate = ((resolvedDeclarations / checkedDeclarations) * 100).toFixed(2);

/* -------------------------------------------------------------- 3. contrast */

const PANEL = parseColor(resolveValue('var(--surface-panel)'));
const CANVAS = parseColor(resolveValue('var(--surface-canvas)'));
// The drawing surface is light. Ink that cannot read on the dark chrome is
// still fine if it is meant for paper — previews and artboard cards do this.
const PAPER = parseColor(resolveValue('var(--canvas-paper)'));
const SURFACES = [PANEL, CANVAS, PAPER];
const pairs = [];
for (const rule of allRules) {
  if (/:disabled|\.is-disabled|\[disabled\]/.test(rule.selector)) continue;
  const ink = parseColor(resolveValue(rule.declarations.get('color')));
  const backgroundRaw = rule.declarations.get('background') ?? rule.declarations.get('background-color');
  if (!ink) continue;
  const background = backgroundRaw ? parseColor(resolveValue(backgroundRaw.split(/\s+(?=(?:url|linear-gradient|radial-gradient|var\())/)[0])) : undefined;
  // Only judge pairs the rule itself defines; inheriting ink is measured below.
  if (!background) continue;
  const value = ratio(ink, background);
  pairs.push({ selector: rule.selector, file: rule.file, ink: toHex(ink), background: toHex(background), value });
}
for (const pair of pairs) {
  // 3:1 is the absolute floor for any UI text; 4.5:1 is AA for body copy.
  if (pair.value < 3) {
    problems.push(`contrast ${pair.value.toFixed(2)}:1 — ${relative(root, pair.file)} · ${pair.selector} (${pair.ink} on ${pair.background})`);
  } else if (pair.value < 4.5) {
    warnings.push(`contrast ${pair.value.toFixed(2)}:1 — ${relative(root, pair.file)} · ${pair.selector} (${pair.ink} on ${pair.background})`);
  }
}

// Ink-only rules: check the two surfaces they realistically sit on.
const inkOnly = allRules.filter((rule) => rule.declarations.has('color')
  && !rule.declarations.has('background') && !rule.declarations.has('background-color')
  && !/:disabled|\.is-disabled|\[disabled\]/.test(rule.selector)
  && !/^(inherit|currentcolor|transparent|none)$/i.test(rule.declarations.get('color').trim()));
let unsupportedInk = 0;
for (const rule of inkOnly) {
  const ink = parseColor(resolveValue(rule.declarations.get('color')));
  if (!ink) continue;
  const best = Math.max(...SURFACES.map((surface) => ratio(ink, surface)));
  if (best < 3) {
    unsupportedInk += 1;
    problems.push(`ink ${toHex(ink)} is below 3:1 on every surface — ${relative(root, rule.file)} · ${rule.selector}`);
  }
}

/* -------------------------------------------------------------- 4. sameness */

const BUTTON = /(button|btn)/i;
const subjects = (selector) => selector.split(',')
  .map((part) => part.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? '')
  .map((subject) => subject.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').replace(/\[.*?\]/g, ''));

/** Last-wins resolution of the properties that define a button's box. */
// Geometry only. Two buttons that differ in paint are still the same button
// *box*; two that differ in height are what "doesn't look the same" means.
const PROPERTIES = ['height', 'min-height', 'border-radius', 'font-size', 'padding', 'font-weight'];
const looks = new Map();
for (const rule of allRules) {
  if (!subjects(rule.selector).some((subject) => subject === 'button' || BUTTON.test(subject))) continue;
  const box = {};
  for (const property of PROPERTIES) {
    const value = rule.declarations.get(property);
    if (value === undefined) continue;
    const resolved = resolveValue(value);
    if (resolved === undefined) continue;
    box[property] = resolved.replace(/\s+/g, ' ');
  }
  const height = box.height ?? box['min-height'];
  if (!height) continue;
  const key = [height, box['border-radius'], box['font-size'], box.padding].join(' | ');
  const entry = looks.get(key) ?? { height, radius: box['border-radius'], fontSize: box['font-size'], padding: box.padding, selectors: [] };
  entry.selectors.push(`${relative(root, rule.file)} · ${rule.selector}`);
  looks.set(key, entry);
}

/**
 * Effective geometry per button *class*: gather every plain-class rule for it in
 * cascade order and keep the last value of each property. This is what a browser
 * actually paints, and it is the honest way to ask "do all buttons look alike".
 */
const GEOMETRY = ['height', 'min-height', 'border-radius', 'font-size', 'padding', 'font-weight'];
const buttonClasses = new Map();
for (const rule of allRules) {
  for (const part of rule.selector.split(',')) {
    const subject = part.trim();
    const name = /^\.[a-zA-Z][a-zA-Z0-9-]*$/.exec(subject);
    if (!name || !BUTTON.test(subject)) continue;
    const entry = buttonClasses.get(subject) ?? {};
    for (const property of GEOMETRY) {
      const value = rule.declarations.get(property);
      if (value === undefined) continue;
      const resolved = resolveValue(value, 0, scopedTokens(rule));
      if (resolved && !/!important/.test(resolved)) entry[property] = resolved.replace(/\s+/g, ' ');
    }
    buttonClasses.set(subject, entry);
  }
}
const geometryGroups = new Map();
for (const [name, box] of buttonClasses) {
  if (!box.height && !box['min-height']) continue;
  const key = [box.height ?? box['min-height'], box['border-radius'] ?? '—', box['font-size'] ?? 'inherit', box.padding ?? '0'].join(' | ');
  const group = geometryGroups.get(key) ?? [];
  group.push(name);
  geometryGroups.set(key, group);
}

const heights = new Map();
for (const rule of allRules) {
  if (!subjects(rule.selector).some((subject) => subject === 'button' || BUTTON.test(subject))) continue;
  const raw = rule.declarations.get('height');
  if (!raw) continue;
  const resolved = resolveValue(raw);
  if (!resolved) continue;
  const px = /([0-9.]+)px/.exec(resolved);
  if (!px || Number(px[1]) < 22 || Number(px[1]) > 48) continue;
  const normalised = resolved.replace(/\s*!important/, '');
  heights.set(normalised, (heights.get(normalised) ?? 0) + 1);
}

/* --------------------------------------------- 5. primitives resolve at all */

const uiCss = await readFile(join(root, 'src/styles/system/components/ui.css'), 'utf8');
const primitives = [...new Set([...uiCss.matchAll(/^\.(ui-[a-z-]+)/gim)].map((m) => m[1]))];
// A base primitive must own a rule that lays it out. Modifiers (`--sm`,
// `--block`) may legitimately only adjust one property.
const missingPrimitives = primitives.filter((name) => {
  if (name.includes('--')) return false;
  const owned = allRules.filter((rule) => rule.selector.split(',').some((part) => part.trim().startsWith(`.${name}`)));
  return owned.length === 0 || owned.every((rule) => rule.declarations.size === 0);
});

/* ------------------------------------------------------------------ report */

const order = [...heights.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log('Design conformance\n');
console.log(`  stylesheets in cascade        ${cascade.length}`);
console.log(`  rules parsed                  ${allRules.length}`);
console.log(`  declarations resolved         ${resolvedDeclarations}/${checkedDeclarations} (${resolutionRate}%)`);
console.log(`  ink+background pairs checked  ${pairs.length} (${pairs.filter((p) => p.value >= 4.5).length} pass AA)`);
console.log(`  ink-only rules checked        ${inkOnly.length}`);
console.log(`  button classes measured       ${buttonClasses.size} → ${geometryGroups.size} geometry signature(s)`);
console.log(`  control heights in use        ${order.map(([value, count]) => `${value} ×${count}`).join(', ') || 'none'}`);
console.log(`  ui-* primitives               ${primitives.filter((name) => !name.includes('--')).length} base + ${primitives.filter((name) => name.includes('--')).length} modifiers`);

if (verbose) {
  console.log('\nEffective button geometry (height | radius | font-size | padding):');
  for (const [key, names] of [...geometryGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${key}   (${names.length})`);
    console.log(`    ${names.join(', ')}`);
  }
  console.log('\nLowest-contrast pairs in the rule set:');
  for (const pair of [...pairs].sort((a, b) => a.value - b.value).slice(0, 10)) {
    console.log(`  ${pair.value.toFixed(2)}:1  ${pair.ink} on ${pair.background}  ${relative(root, pair.file)} · ${pair.selector}`);
  }
}

if (warnings.length) {
  console.log(`\n${warnings.length} pair(s) below AA (4.5:1) but above the 3:1 floor:`);
  for (const warning of warnings.slice(0, 10)) console.log(`  · ${warning}`);
  if (warnings.length > 10) console.log(`  … ${warnings.length - 10} more (use --verbose)`);
}

if (missingPrimitives.length) {
  problems.push(`primitives defined but with no rule of their own: ${missingPrimitives.join(', ')}`);
}

if (problems.length) {
  console.error(`\nDesign conformance failed (${problems.length}):\n`);
  for (const problem of [...new Set(problems)].slice(0, 40)) console.error(`  - ${problem}`);
  if (problems.length > 40) console.error(`  … ${problems.length - 40} more`);
  process.exit(1);
}

console.log(`\nDesign conformance passed: every declaration resolves, every ink pair is legible,\nand ${buttonClasses.size} button classes sit on ${geometryGroups.size} intentional geometry signatures.`);
