#!/usr/bin/env node
/**
 * Design-system enforcement.
 *
 * Fails when the product drifts away from one visual language:
 *   1. token integrity   — every token declared once, hex values valid, no dead aliases
 *   2. palette parity    — src/design-system/tokens.ts matches tokens.css
 *   3. no new literals   — feature CSS/TS must not add raw colours (baseline ratchet)
 *   4. no stray tokens   — feature files must not redefine tokens (`:root` blocks)
 *   5. contrast          — semantic text/surface pairs meet WCAG AA
 *   6. no dangling vars  — every var(--x) is declared in CSS or set at runtime
 *   7. chrome ≠ canvas   — feature CSS may not borrow overlay or canvas ink
 *
 * The baseline records the literals that existed when the system landed. It may
 * only shrink: deleting a fix is never easier than keeping it.
 *
 * Usage: node scripts/design-system/check.mjs [--report] [--verbose] [--list]
 *        node scripts/design-system/check.mjs --update   (rewrite baseline.json)
 *
 * `--update` is deliberate: it rewrites the ratchet to today's numbers, so the
 * only honest reason to run it is that a migration *removed* literals.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio, deltaE2000, normalizeHex } from './lib/color.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reportOnly = process.argv.includes('--report');
const problems = [];
const notes = [];

const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

async function walk(directory, filter) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path, filter)));
    else if (filter(path)) out.push(path);
  }
  return out;
}

/* ------------------------------------------------------- 1. token integrity */
const tokensCss = await readFile(join(root, 'src/styles/system/tokens.css'), 'utf8');
const declared = new Map();
for (const match of tokensCss.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/gim)) {
  const [, name, value] = match;
  if (declared.has(name)) problems.push(`tokens.css declares ${name} more than once`);
  declared.set(name, value.trim());
}
if (declared.size < 80) problems.push(`tokens.css only declares ${declared.size} tokens; expected the full system`);

for (const [name, value] of declared) {
  for (const raw of value.match(HEX) ?? []) {
    if (!/^#[0-9a-fA-F]{3,8}$/.test(raw)) problems.push(`${name} has an invalid colour ${raw}`);
  }
  for (const reference of value.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
    if (!declared.has(reference[1])) problems.push(`${name} references undeclared token ${reference[1]}`);
  }
}

/* ---------------------------------------------------------- 2. palette parity */
const tsSource = await readFile(join(root, 'src/design-system/tokens.ts'), 'utf8');
const tsColors = new Map();
for (const match of tsSource.matchAll(/^\s{2}([a-zA-Z0-9]+):\s*'(#[0-9a-fA-F]{6})'/gm)) {
  tsColors.set(match[1], normalizeHex(match[2]));
}
const cssColors = new Set();
for (const value of declared.values()) {
  for (const raw of value.match(HEX) ?? []) cssColors.add(normalizeHex(raw));
}
for (const [key, hex] of tsColors) {
  if (!cssColors.has(hex)) {
    problems.push(`tokens.ts exports ${key} (${hex}) but no token in tokens.css has that value`);
  }
}

/* ------------------------------------------------------- 3. literal colours */
const styleFiles = await walk(join(root, 'src/styles'), (p) => p.endsWith('.css'))
  .then((files) => files.filter((file) => !file.includes('/system/')));
const codeFiles = await walk(join(root, 'src'), (p) => /\.(ts|tsx)$/.test(p))
  .then((files) => files.filter((file) => !exemptFromLiterals(file)));

const baselineRaw = JSON.parse(await readFile(join(root, 'scripts/design-system/baseline.json'), 'utf8'));

/**
 * Files allowed to contain raw colour literals: the two token sources that
 * *define* the palette, and test fixtures that intentionally assert arbitrary
 * user-supplied colours. Everything else must reference a token.
 */
function exemptFromLiterals(file) {
  return file.includes('/src/design-system/') || /\.test\.(ts|tsx)$/.test(file);
}

function countLiterals(text, file) {
  const counts = new Map();
  // Skip imports, comments and doc strings: examples are not applied colours.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/url\([^)]*\)/g, '');
  for (const raw of stripped.match(HEX) ?? []) {
    const hex = normalizeHex(raw);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return counts;
}

const literalTotals = { css: 0, code: 0 };
const offenders = [];
for (const [kind, files] of [['css', styleFiles], ['code', codeFiles]]) {
  for (const file of files) {
    const key = relative(root, file);
    const counts = countLiterals(await readFile(file, 'utf8'), file);
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    if (!total) continue;
    literalTotals[kind] += total;
    const allowed = baselineRaw[key] ?? 0;
    if (total > allowed) {
      offenders.push(`${key}: ${total} literal colours, baseline allows ${allowed}`);
    }
    for (const [hex, n] of counts) {
      const permitted = (baselineRaw.colors ?? {})[hex] ?? 0;
      // A brand-new colour is drift even when the file stays under its cap:
      // swapping one stray tint for another must not look like progress.
      if (permitted === 0 && !baselineRaw.allowNewColors) {
        problems.push(`${key}: introduces a new literal colour ${hex} (x${n}); use a token`);
      }
    }
  }
}
for (const offender of offenders) problems.push(offender);

/* -------------------------------------------------------- 4. token redefinition */
for (const file of styleFiles) {
  const text = await readFile(file, 'utf8');
  if (/:root\s*\{/.test(text)) {
    problems.push(`${relative(root, file)} redefines :root tokens; the palette lives only in system/tokens.css`);
  }
}

/* --------------------------------------------------------------- 5. contrast */
const resolve = (name, depth = 0) => {
  const value = declared.get(name);
  if (!value || depth > 6) return undefined;
  const reference = /var\((--[a-zA-Z0-9-]+)/.exec(value);
  return reference ? resolve(reference[1], depth + 1) : (value.match(HEX)?.[0] ?? undefined);
};
const pairs = [
  ['--text-primary', '--surface-canvas', 4.5],
  ['--text-primary', '--surface-panel', 4.5],
  ['--text-secondary', '--surface-panel', 4.5],
  ['--text-muted', '--surface-canvas', 4.5],
  ['--text-muted', '--surface-panel', 4.5],
  ['--accent', '--surface-panel', 3],
  ['--accent', '--surface-canvas', 3],
  ['--text-on-accent', '--accent-solid', 4.5],
  ['--text-on-accent', '--accent-solid-hover', 4.5],
  ['--text-danger', '--surface-panel', 3],
  ['--text-success', '--surface-panel', 3],
];
for (const [fg, bg, minimum] of pairs) {
  const foreground = resolve(fg);
  const background = resolve(bg);
  if (!foreground || !background) {
    problems.push(`contrast pair ${fg} on ${bg} cannot be resolved`);
    continue;
  }
  const ratio = contrastRatio(foreground, background);
  if (ratio < minimum) {
    problems.push(`${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the ${minimum}:1 target`);
  } else {
    notes.push(`${fg} on ${bg} — ${ratio.toFixed(2)}:1`);
  }
}

/* ------------------------------------------------------- 6. dangling vars */
// A `var(--typo)` renders as nothing and fails silently in the browser, so every
// reference must resolve: either declared by a stylesheet, or set on an element
// from TypeScript (the shell sets --sidebar-width, --layers-height, --lp-depth).
const cssFiles = await walk(join(root, 'src/styles'), (p) => p.endsWith('.css'));
const declaredAnywhere = new Set();
const referenced = new Map();
for (const file of cssFiles) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gim)) declaredAnywhere.add(match[1]);
  for (const match of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    const list = referenced.get(match[1]) ?? [];
    if (!list.includes(file)) list.push(file);
    referenced.set(match[1], list);
  }
}
const codeSource = await walk(join(root, 'src'), (p) => /\.(ts|tsx)$/.test(p));
const runtimeVars = new Set();
for (const file of codeSource) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/['"](--[a-zA-Z0-9-]+)['"]\s*:/g)) runtimeVars.add(match[1]);
  for (const match of text.matchAll(/setProperty\(\s*['"](--[a-zA-Z0-9-]+)['"]/g)) runtimeVars.add(match[1]);
}
for (const [name, files] of referenced) {
  if (declaredAnywhere.has(name) || runtimeVars.has(name)) continue;
  const where = files.slice(0, 3).map((file) => relative(root, file)).join(', ');
  problems.push(`var(${name}) is never declared (${where}${files.length > 3 ? ', …' : ''})`);
}

/* --------------------------------------------------- 7. chrome is not canvas */
// The canvas palette describes artwork and transient tool affordances. Chrome
// referencing it is almost always an accident of a near-identical hex. The two
// exceptions are legends that intentionally mirror the affordance they describe.
const MIRROR_SELECTORS = /(\.hint-dot\b|\.fill-actions\b)/;
const PREVIEW_BACKGROUNDS = /^background(-image)?$/;
for (const file of styleFiles) {
  const text = await readFile(file, 'utf8');
  for (const block of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = block[1].trim();
    for (const declaration of block[2].matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]*)/g)) {
      const [, property, value] = declaration;
      for (const match of value.matchAll(/var\((--(?:overlay|canvas)-[a-zA-Z0-9-]+)/g)) {
        const token = match[1];
        if (PREVIEW_BACKGROUNDS.test(property) && /^--canvas-(paper|grid-minor|grid-major)$/.test(token)) continue;
        if (MIRROR_SELECTORS.test(selector)) continue;
        problems.push(`${relative(root, file)}: chrome uses canvas token ${token} for ${property} (${selector.slice(0, 40) || 'unknown selector'})`);
      }
    }
  }
}

/* ------------------------------------------------------- 8. baseline update */
if (process.argv.includes('--update')) {
  const next = { colors: {} };
  const bump = (bucket, hex, n) => { bucket[hex] = (bucket[hex] ?? 0) + n; };
  for (const [kind, files] of [['css', styleFiles], ['code', codeFiles]]) {
    for (const file of files) {
      const counts = countLiterals(await readFile(file, 'utf8'), file);
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      if (!total) continue;
      next[relative(root, file)] = total;
      for (const [hex, n] of counts) bump(next.colors, hex, n);
    }
  }
  const path = join(root, 'scripts/design-system/baseline.json');
  const before = JSON.parse(await readFile(path, 'utf8'));
  const beforeTotal = Object.entries(before)
    .filter(([key]) => key !== 'colors' && key !== 'allowNewColors')
    .reduce((sum, [, n]) => sum + n, 0);
  const afterTotal = Object.entries(next)
    .filter(([key]) => key !== 'colors')
    .reduce((sum, [, n]) => sum + n, 0);
  if (afterTotal > beforeTotal) {
    console.error(`Refusing to raise the ratchet: ${beforeTotal} -> ${afterTotal} literals.`);
    process.exit(1);
  }
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Baseline updated: ${Object.keys(next).length - 1} files, ${Object.keys(next.colors).length} colours (${beforeTotal} -> ${afterTotal} literals).`);
  process.exit(0);
}

/* -------------------------------------------------------------- 9. drift list */
if (process.argv.includes('--list')) {
  const near = new Map();
  for (const file of styleFiles) {
    for (const [hex, n] of countLiterals(await readFile(file, 'utf8'), file)) {
      let best;
      for (const [name, value] of declared) {
        const candidate = value.match(HEX)?.[0];
        if (!candidate) continue;
        const d = deltaE2000(hex, normalizeHex(candidate));
        if (!best || d < best.d) best = { name, d };
      }
      near.set(hex, { n, best });
    }
  }
  for (const [hex, { n, best }] of [...near].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
    console.log(`  ${hex} x${n}  nearest ${best.name} ΔE ${best.d.toFixed(1)}`);
  }
}

/* -------------------------------------------------------------------- report */
console.log(`Design system: ${declared.size} tokens, ${tsColors.size} mirrored values.`);
console.log(`Literal colours remaining — CSS ${literalTotals.css}, TS ${literalTotals.code} (tracked in baseline.json).`);
if (process.argv.includes('--verbose')) for (const note of notes) console.log(`  · ${note}`);

if (problems.length) {
  console.error('\nDesign-system check failed:\n');
  for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`);
  if (reportOnly) process.exit(0);
  process.exit(1);
}
console.log('Design-system check passed: one palette, no drift.');
