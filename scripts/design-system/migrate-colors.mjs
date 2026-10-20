#!/usr/bin/env node
/**
 * Rewrite a stylesheet so every literal colour becomes a design-system token.
 *
 * The token list is *read from `src/styles/system/tokens.css`*, so the codemod
 * can never drift from the palette it is migrating towards: add a token there
 * and the next run picks it up.
 *
 * Two safety rules:
 *   1. Distance. A hex is only replaced when the nearest token is within
 *      `--budget` CIEDE2000, default 1.5 (invisible). Higher budgets are for a
 *      deliberate consolidation and are always printed.
 *   2. Role. A token whose name marks it as a surface is never substituted for
 *      text, and an ink token is never substituted for a background. Without
 *      this, a near-identical pair can repaint text as a panel.
 *
 * Usage:
 *   node scripts/design-system/migrate-colors.mjs [--report] [--budget=N] [files…]
 *   node scripts/design-system/migrate-colors.mjs --report --all
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deltaE2000, isHexColor, normalizeHex } from './lib/color.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stylesDir = join(root, 'src/styles');
const SYSTEM_DIR = join(stylesDir, 'system');
const TOKENS_FILE = join(SYSTEM_DIR, 'tokens.css');

const budgetArg = process.argv.find((arg) => arg.startsWith('--budget='));
const MAX_ACCEPTED_DELTA_E = budgetArg ? Number(budgetArg.split('=')[1]) : 1.5;

const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

/* --------------------------------------------------------------- token table */

/**
 * Read `tokens.css` and resolve every token to a single hex value.
 * Tokens that resolve to rgba(), gradients or another non-colour form are
 * skipped: they cannot be compared perceptually.
 */
export function loadTokens(file = TOKENS_FILE) {
  const css = readFileSync(file, 'utf8');
  const declared = new Map();
  for (const match of css.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/gim)) {
    declared.set(match[1], match[2].trim());
  }
  const resolve = (name, depth = 0) => {
    const value = declared.get(name);
    if (!value || depth > 8) return undefined;
    const alias = /^var\((--[a-zA-Z0-9-]+)\)$/.exec(value);
    if (alias) return resolve(alias[1], depth + 1);
    const hex = value.match(HEX);
    if (!hex || value.replace(hex[0], '').trim() !== '') return undefined;
    return normalizeHex(hex[0]);
  };
  const table = new Map();
  for (const name of declared.keys()) {
    const hex = resolve(name);
    if (hex) table.set(name, hex);
  }
  return table;
}

/**
 * What kind of paint a token is meant for, inferred from its name.
 * Canvas and overlay tokens describe artwork and transient tool affordances;
 * chrome must never borrow them, so they get a role of their own.
 */
export function tokenRole(name) {
  if (/^--(overlay|canvas)-/.test(name)) return 'canvas';
  if (/ink|^--text-|-text-/.test(name)) return 'ink';
  if (/surface|paper|-wash$/.test(name)) return 'surface';
  if (/border/.test(name)) return 'border';
  return 'any';
}

/** What kind of paint a CSS property accepts. */
export function propertyRole(property) {
  if (!property) return 'any';
  if (property.startsWith('--')) return 'any';
  if (/^(color|fill|stroke|caret-color|text-decoration-color|-webkit-text-fill-color)$/.test(property)) return 'ink';
  if (/^background(-image)?$/.test(property) || property === 'box-shadow') return 'surface';
  if (/^border/.test(property) || /^outline/.test(property)) return 'border';
  return 'any';
}

const COMPATIBLE = {
  ink: new Set(['ink', 'any']),
  surface: new Set(['surface', 'border', 'any']),
  border: new Set(['border', 'surface', 'any']),
  any: new Set(['ink', 'surface', 'border', 'any']),
};
// 'canvas' appears in no set above on purpose: chrome never borrows the drawing
// surface or a tool overlay colour. Those tokens stay available to the
// renderers through tokens.ts.

/** Nearest token of a compatible role within the budget, or undefined. */
export function tokenFor(hex, { tokens, property, budget = MAX_ACCEPTED_DELTA_E } = {}) {
  const table = tokens ?? loadTokens();
  const wanted = propertyRole(property);
  const normalized = normalizeHex(hex);
  let best;
  for (const [name, value] of table) {
    const role = tokenRole(name);
    if (!COMPATIBLE[wanted].has(role)) continue;
    // A paint token must not be used the other way round either.
    if (wanted === 'ink' && role === 'surface') continue;
    const distance = deltaE2000(normalized, value);
    if (!best || distance < best.distance) best = { name, distance, role };
    if (distance === 0) break;
  }
  return best && best.distance <= budget ? best : undefined;
}

/* ------------------------------------------------------------- substitution */

/**
 * Tokens are always defined (tokens.css loads first), so a substitution emits a
 * plain var() reference. Keeping the original value as a fallback would leave a
 * literal behind and make a second run nest var() inside itself.
 */
function reference(name) {
  return `var(${name})`;
}

/** Collapses a fallback that is just the token itself or a raw colour. */
export function normalizeFallbacks(source) {
  const pattern = /var\((--[a-zA-Z0-9-]+),\s*(?:var\(\1[^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))\s*\)/g;
  let previous;
  let current = source;
  do {
    previous = current;
    current = current.replace(pattern, 'var($1)');
  } while (current !== previous);
  return current;
}

/**
 * Replace hex literals inside declarations only. Selectors, comments, content
 * strings and data URIs are never touched.
 */
export function rewriteColors(source, options = {}) {
  const accepted = new Map();
  const skipped = new Map();
  const tokens = options.tokens ?? loadTokens();
  const budget = options.budget ?? MAX_ACCEPTED_DELTA_E;

  // Never rewrite inside url(...) or quoted strings: those are assets and
  // literal content, not theme values.
  const shielded = [];
  const shield = (text) => text.replace(/url\((?:[^()]|\\([^)])*)\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (match) => {
    shielded.push(match);
    return `\u0000${shielded.length - 1}\u0000`;
  });
  const unshield = (text) => text.replace(/\u0000(\d+)\u0000/g, (_, i) => shielded[Number(i)]);
  source = shield(source);

  // Match any brace block whose body contains no nested block. Multi-line
  // selector lists are common in this codebase, so the prelude may span lines.
  const out = source.replace(/([^{}]*\{)([^{}]*)(\})/g, (whole, open, body) => {
    if (open.includes('@')) return whole;
    const rewritten = body.replace(/([a-zA-Z-]+)\s*:\s*([^;{}]*)/g, (declaration, property, value) =>
      declaration.replace(HEX, (hex) => {
        if (!isHexColor(hex)) return hex;
        const match = tokenFor(hex, { tokens, property, budget });
        if (!match) {
          skipped.set(normalizeHex(hex), (skipped.get(normalizeHex(hex)) ?? 0) + 1);
          return hex;
        }
        accepted.set(match.name, (accepted.get(match.name) ?? 0) + 1);
        return reference(match.name);
      }),
    );
    return `${open}${rewritten}}`;
  });
  return { out: normalizeFallbacks(unshield(out)), accepted, skipped };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--budget='));
  const reportOnly = args.includes('--report');
  const all = args.includes('--all');
  const explicit = args.filter((a) => !a.startsWith('--'));

  const files = all || explicit.length === 0
    ? (await readdir(stylesDir))
      .filter((f) => f.endsWith('.css'))
      .map((f) => join(stylesDir, f))
      // System files define the tokens themselves; they are the only place
      // literals are allowed and must not be rewritten into aliases of themselves.
      .filter((file) => !file.startsWith(SYSTEM_DIR))
    : explicit.map((f) => join(root, f));

  const tokens = loadTokens();
  let totalAccepted = 0;
  let totalSkipped = 0;
  const allSkipped = new Map();

  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const { out, accepted, skipped } = rewriteColors(before, { tokens, budget: MAX_ACCEPTED_DELTA_E });
    const acceptedCount = [...accepted.values()].reduce((s, n) => s + n, 0);
    const skippedCount = [...skipped.values()].reduce((s, n) => s + n, 0);
    totalAccepted += acceptedCount;
    totalSkipped += skippedCount;
    for (const [hex, n] of skipped) allSkipped.set(hex, (allSkipped.get(hex) ?? 0) + n);
    if (!reportOnly && out !== before) writeFileSync(file, out);
    if (acceptedCount || skippedCount) {
      console.log(
        `${relative(root, file).padEnd(38)} tokenised ${String(acceptedCount).padStart(3)}  kept ${String(skippedCount).padStart(3)}`,
      );
    }
  }

  console.log(`\nBudget ΔE ${MAX_ACCEPTED_DELTA_E}. Total: ${totalAccepted} hex values tokenised, ${totalSkipped} left literal${reportOnly ? ' (report only)' : ''}.`);
  if (allSkipped.size) {
    const worst = [...allSkipped].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log(`\nKept literal (no compatible token within ΔE ${MAX_ACCEPTED_DELTA_E}):`);
    for (const [hex, n] of worst) {
      const nearest = [...tokens]
        .map(([name, value]) => ({ name, d: deltaE2000(hex, value) }))
        .sort((a, b) => a.d - b.d)[0];
      console.log(`  ${hex} x${n} — nearest ${nearest.name} at ΔE ${nearest.d.toFixed(1)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
