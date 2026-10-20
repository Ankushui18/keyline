#!/usr/bin/env node
/**
 * Consistency audit.
 *
 * The colour gate answers "is the palette one palette". This answers the harder
 * question: *does the product look the same everywhere?* It measures how many
 * distinct values each visual dimension actually uses, and how many of them sit
 * on the design-system scale.
 *
 * Usage:
 *   node scripts/design-system/audit.mjs            # summary table
 *   node scripts/design-system/audit.mjs --details  # list every off-scale value
 *   node scripts/design-system/audit.mjs --json     # machine-readable
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const details = process.argv.includes('--details');
const asJson = process.argv.includes('--json');

async function walk(dir, filter) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path, filter)));
    else if (filter(path)) out.push(path);
  }
  return out;
}

const tokensCss = await readFile(join(root, 'src/styles/system/tokens.css'), 'utf8');
const tokenValue = (name) => {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(tokensCss);
  return match ? match[1].trim() : undefined;
};
const numbersOf = (prefix) => {
  const values = new Set();
  for (const match of tokensCss.matchAll(new RegExp(`^\\s*(${prefix}[a-z0-9-]*)\\s*:\\s*([0-9.]+)px`, 'gim'))) {
    values.add(Number(match[2]));
  }
  return values;
};

const spaceStep = (name) => {
  const match = new RegExp(`^\\s*${name}\\s*:\\s*([0-9.]+)px`, 'mi').exec(tokensCss);
  return match ? Number(match[1]) : undefined;
};

const scales = {
  'font-size': numbersOf('--font-size-'),
  radius: numbersOf('--radius-'),
  space: numbersOf('--space-'),
};

const cssFiles = (await walk(join(root, 'src/styles'), (p) => p.endsWith('.css')))
  .filter((file) => !file.includes('/system/'));
const codeFiles = await walk(join(root, 'src'), (p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'));

/** Collect [value, file, selector-ish context] for a property pattern. */
async function collect(files, pattern, kind) {
  const found = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const key = relative(root, file);
    if (kind === 'css') {
      for (const line of text.split('\n')) {
        for (const match of line.matchAll(pattern)) {
          found.push({ token: match[1], raw: match[2], value: match[1] ?? match[2], file: key, line: line.trim().slice(0, 110) });
        }
      }
    } else {
      for (const match of text.matchAll(pattern)) found.push({ value: match[1], file: key, line: match[0].slice(0, 110) });
    }
  }
  return found;
}

// Declarations may carry a literal or a token reference; count both so the
// audit measures what the browser actually uses, not just what escaped.
const px = (name) => new RegExp(`${name}\\s*:\\s*(?:var\\((--[a-zA-Z0-9-]+)\\)|(-?[0-9.]+)px)`, 'g');
const tokenPx = (name) => {
  const match = new RegExp(`^\\s*${name}\\s*:\\s*([0-9.]+)px`, 'mi').exec(tokensCss);
  return match ? Number(match[1]) : undefined;
};
const resolveValue = (entry) => (entry.token ? tokenPx(entry.token) : Number(entry.raw));
const findings = {
  'font-size': await collect(cssFiles, px('font-size'), 'css'),
  'font shorthand': await collect(cssFiles, /font\s*:\s*[^;]*?'(Geist[^']*)'/g, 'css'),
  'font-family': await collect(cssFiles, /font-family\s*:\s*([^;]+)/g, 'css'),
  radius: await collect(cssFiles, /border(?:-[a-z]+)?-radius\s*:\s*([^;]+)/g, 'css'),
  'font token': await collect(cssFiles, /font-family\s*:\s*(var\(--font-[a-z]+\))/g, 'css'),
  gap: await collect(cssFiles, /(?:^|;)\s*gap\s*:\s*(?:var\((--space-[a-z0-9-]+)\)|([0-9.]+)px)/g, 'css'),
  padding: await collect(cssFiles, /padding\s*:\s*([^;{}]+)/g, 'css'),
  'line-height': await collect(cssFiles, /line-height\s*:\s*([0-9.]+)/g, 'css'),
  'z token': await collect(cssFiles, /z-index\s*:\s*(var\(--z-[a-z0-9-]+\))/g, 'css'),
  'z-index': await collect(cssFiles, /z-index\s*:\s*(-?[0-9]+)/g, 'css'),
  'inline px': await collect(codeFiles, /:\s*'(-?[0-9.]+px)'/g, 'ts'),
  important: await collect(cssFiles, /(!important)/g, 'css'),
};

const numeric = (list) => list.map((entry) => Number.parseFloat(entry.value)).filter((n) => Number.isFinite(n));
const distinct = (list) => [...new Set(list)].sort((a, b) => a - b);

// Control heights only count on the control's own selector, not on its glyphs.
const controlHeights = new Set();
for (const file of cssFiles) {
  const text = await readFile(file, 'utf8');
  for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const subjects = block[1]
      .split(',')
      .map((part) => part.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? '')
      .map((subject) => subject.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').replace(/\[.*?\]/g, ''));
    if (!subjects.some((subject) => /(button|btn)/i.test(subject) || subject === 'button')) continue;
    for (const match of block[2].matchAll(/height\s*:\s*(?:var\((--control-height-[a-z0-9-]+)\)|([0-9.]+)px)/g)) {
      const value = match[1] ? spaceStep(match[1]) : Number(match[2]);
      if (Number.isFinite(value)) controlHeights.add(value);
    }
  }
}

const report = {};
const radiusValues = distinct(
  findings.radius.flatMap((entry) => [
    ...[...entry.value.matchAll(/var\((--radius-[a-z0-9-]+)\)/g)].map((m) => tokenPx(m[1])),
    ...[...entry.value.matchAll(/(-?[0-9.]+)px/g)].map((m) => Number(m[1])),
  ]).filter((n) => Number.isFinite(n)),
);
const fontSizeValues = distinct(findings['font-size'].map(resolveValue).filter((n) => Number.isFinite(n)));
const zValues = distinct(numeric(findings['z-index']));

report.type = {
  declaredSizes: fontSizeValues.length,
  onScale: fontSizeValues.filter((value) => scales['font-size'].has(value)).length,
  offScale: fontSizeValues.filter((value) => !scales['font-size'].has(value)),
  usages: findings['font-size'].length,
  shorthandFamilies: findings['font shorthand'].length,
  longhandLiterals: findings['font-family'].filter((entry) => !entry.value.startsWith('var(--font-') && entry.value !== 'inherit').length,
  tokenisedFamilies: findings['font token'].length,
};
report.radius = {
  declaredValues: radiusValues.length,
  onScale: radiusValues.filter((value) => scales.radius.has(value)).length,
  offScale: radiusValues.filter((value) => !scales.radius.has(value)),
  usages: findings.radius.length,
};
report.layering = { declaredValues: zValues.length, values: zValues, tokenRefs: findings['z token'].length };

const gapValues = distinct(
  findings.gap.flatMap((entry) => (entry.token ? [spaceStep(entry.token)] : [Number(entry.raw)])).filter((n) => Number.isFinite(n)),
);
const paddingTokens = new Set(findings.padding.flatMap((entry) => [...entry.value.matchAll(/var\((--space-[a-z0-9-]+)\)/g)].map((m) => m[1])));
const paddingLiterals = findings.padding
  .filter((entry) => !/calc\(/.test(entry.value))
  .flatMap((entry) => [...entry.value.matchAll(/(^|\s)([0-9.]+)px/g)]
    .map((m) => Number(m[2])).filter((size) => size > 0 && size <= 48));
report.spacing = {
  distinctGaps: gapValues.length,
  offGridGaps: gapValues.filter((value) => !scales.space.has(value)),
  gapUsages: findings.gap.length,
  paddingTokens: paddingTokens.size,
  paddingLiterals: paddingLiterals.length,
  distinctPaddings: new Set(findings.padding.map((entry) => entry.value.trim())).size,
  lineHeights: distinct(numeric(findings['line-height'])),
  controlHeights: [...controlHeights].filter((n) => n >= 22 && n <= 48).sort((a, b) => a - b),
};
report.inline = { pxLiterals: findings['inline px'].length };
report.specificity = { important: findings.important.length };

// Raw colour literals the gate is ratcheting.
const literalCss = (await Promise.all(cssFiles.map((file) => readFile(file, 'utf8'))))
  .join('\n')
  .match(/#(?:[0-9a-fA-F]{6})\b/g) ?? [];
report.colour = { literalHex: literalCss.length };

// Component vocabulary: how many bespoke button-ish classes exist.
const classNames = new Set();
for (const file of cssFiles) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\.([a-zA-Z][a-zA-Z0-9-]*)/g)) classNames.add(match[1]);
}
const buttonish = [...classNames].filter((name) => /(btn|button)$/.test(name) || /-(btn|button)\b/.test(name));
report.components = {
  cssClasses: classNames.size,
  buttonClasses: buttonish.length,
  buttonList: buttonish.sort(),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const row = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);
  console.log('Design consistency audit\n');
  row('font-size declarations', `${report.type.usages} (${report.type.onScale}/${report.type.declaredSizes} sizes on scale)`);
  row('distinct font sizes', `${report.type.declaredSizes} (${report.type.offScale.length} off scale)`);
  row('off-scale sizes', report.type.offScale.join(', ') || 'none');
  row('raw font-family declarations', report.type.shorthandFamilies + report.type.longhandLiterals);
  row('distinct border-radius values', `${report.radius.declaredValues} (${report.radius.offScale.length} off scale)`);
  row('z-index values', `${report.layering.tokenRefs} on tokens, ${report.layering.declaredValues} local literal(s)`);
  row('distinct gaps', `${report.spacing.distinctGaps} values, ${report.spacing.offGridGaps.length} off scale`);
  row('padding', `${report.spacing.paddingTokens} space tokens in use, ${report.spacing.paddingLiterals} literal px`);
  row('distinct padding shorthands', report.spacing.distinctPaddings);
  row('control heights', report.spacing.controlHeights.join(', ') || 'none');
  row('distinct line-heights', report.spacing.lineHeights.join(', '));
  row('inline px literals in TSX', report.inline.pxLiterals);
  row('!important declarations', report.specificity.important);
  row('literal hex in feature CSS', report.colour.literalHex);
  row('CSS classes', report.components.cssClasses);
  row('bespoke button classes', report.components.buttonClasses);
  if (details) {
    console.log('\nOff-scale font sizes:');
    for (const value of report.type.offScale) {
      const hits = findings['font-size'].filter((entry) => Number.parseFloat(entry.value) === value);
      console.log(`  ${value}px ×${hits.length}  e.g. ${hits[0].file}: ${hits[0].line}`);
    }
    console.log('\nOff-scale radii:');
    for (const value of report.radius.offScale) {
      const hits = findings.radius.filter((entry) => {
        const resolved = [
          ...[...entry.value.matchAll(/var\((--radius-[a-z0-9-]+)\)/g)].map((m) => tokenPx(m[1])),
          ...[...entry.value.matchAll(/(-?[0-9.]+)px/g)].map((m) => Number(m[1])),
        ];
        return resolved.includes(value);
      });
      console.log(`  ${value}px ×${hits.length}  e.g. ${hits[0].file}: ${hits[0].line}`);
    }
    console.log('\nz-index values:', report.layering.values.join(', '));
    console.log('\nButton classes:', report.components.buttonList.join(', '));
  }
}
