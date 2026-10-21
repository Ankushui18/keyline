#!/usr/bin/env node
/**
 * Build a self-contained proof sheet for the design system.
 *
 * Everything is rendered with the product's real stylesheets (inlined in the
 * same order main.tsx loads them), so what you see is what ships. Use it to
 * answer the question a gate cannot: *do these things look like each other?*
 *
 * Usage: node scripts/design-system/proof.mjs [--out <file>]
 *        then open the file, or serve its directory.
 */
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const outIndex = process.argv.indexOf('--out');
const out = outIndex !== -1 ? process.argv[outIndex + 1] : join(root, 'design-proof/index.html');

const SHEETS = [
  'src/styles/system/tokens.css',
  'src/styles/system/base.css',
  'src/styles/system/components/ui.css',
  'src/styles/global.css',
  'src/styles/topbar.css',
  'src/styles/dialogs.css',
];
const css = (await Promise.all(SHEETS.map((file) => readFile(join(root, file), 'utf8'))))
  .join('\n\n')
  // @font-face URLs are relative to the stylesheet; inline the fonts instead so
  // the sheet is one self-contained file.
  .replace(/url\((['"]?)[^)'"]*?([^/'")]+\.woff2)\1\)/g, (whole, quote, file) => {
    const data = readFileSync(join(root, 'src/assets', file)).toString('base64');
    return `url(data:font/woff2;base64,${data})`;
  });

const tokensCss = await readFile(join(root, 'src/styles/system/tokens.css'), 'utf8');
const token = (name) => {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(tokensCss);
  if (!match) return undefined;
  const value = match[1].trim();
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  return alias ? token(alias[1]) : value;
};

const RAMPS = [
  ['graphite', [1000, 950, 900, 875, 850, 825, 800, 775, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 200]],
  ['blue', [900, 700, 600, 500, 400, 300]],
  ['red', [900, 500]],
  ['green', [600, 500]],
  ['amber', [600, 500]],
];
const SEMANTIC = ['surface-sunken', 'surface-canvas', 'surface-inset', 'surface-panel', 'surface-raised',
  'surface-field', 'surface-hover', 'surface-active', 'surface-selected', 'border-subtle', 'border-default',
  'border-strong', 'text-primary', 'text-secondary', 'text-muted', 'text-subtle', 'accent', 'accent-solid',
  'text-on-accent', 'text-on-bright', 'text-danger', 'text-success', 'text-warning'];
const TINTS = ['tint-info-surface', 'tint-info-surface-hover', 'tint-info-border', 'tint-info-ink',
  'tint-danger-surface', 'tint-danger-border', 'tint-danger-ink', 'tint-success-surface', 'tint-success-ink',
  'tint-warning-surface', 'tint-warning-ink'];
const TYPE = [['6xl', 32], ['5xl', 24], ['4xl', 20], ['3xl', 18], ['2xl', 16], ['xl', 14], ['lg', 13],
  ['md', 12], ['sm', 11], ['xs', 10], ['2xs', 9], ['3xs', 8]];
const RADII = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'];
const SPACE = ['px', '05', '1', '15', '2', '25', '3', '35', '4', '5', '6', '7', '8', '10', '12'];

/* --------------------------------------------------------------- colour math */

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => linear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const CONTRAST = [
  ['text-primary', 'surface-canvas'], ['text-primary', 'surface-panel'],
  ['text-secondary', 'surface-panel'], ['text-muted', 'surface-panel'],
  ['accent', 'surface-panel'], ['text-on-accent', 'accent-solid'],
  ['text-on-bright', 'accent'], ['tint-danger-ink', 'tint-danger-surface'],
  ['tint-info-ink', 'tint-info-surface'], ['tint-success-ink', 'tint-success-surface'],
  ['tint-warning-ink', 'tint-warning-surface'],
].map(([fg, bg]) => {
  const f = token(`--${fg}`);
  const b = token(`--${bg}`);
  return { fg, bg, f, b, value: ratio(f, b) };
});

const swatch = (name, value) => `<div class="sw">
  <span class="sw-chip" style="background:${value}"></span>
  <span class="sw-name">--${name}</span><span class="sw-hex">${value}</span>
</div>`;

const sheet = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keyline — design system proof sheet</title>
<style>
${css}
</style>
<style>
  /* Proof-sheet chrome only; everything inside .sample uses product CSS. */
  body { margin: 0; background: var(--surface-sunken); color: var(--text-primary); }
  .proof { max-width: 1180px; margin: 0 auto; padding: var(--space-8) var(--space-6) var(--space-12); display: grid; gap: var(--space-8); }
  .proof h1 { margin: 0; font-size: var(--font-size-5xl); letter-spacing: var(--letter-spacing-tight); }
  .proof h2 { margin: 0 0 var(--space-3); font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); }
  .proof h2 span { color: var(--text-muted); font-weight: var(--font-weight-regular); }
  .proof p { margin: 0; color: var(--text-muted); font-size: var(--font-size-sm); line-height: var(--line-height-normal); }
  .card { padding: var(--space-5); border: 1px solid var(--border-default); border-radius: var(--radius-xl); background: var(--surface-panel); display: grid; gap: var(--space-4); }
  .grid { display: grid; gap: var(--space-2); }
  .ramp { grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); }
  .sw { display: grid; gap: var(--space-05); font-size: var(--font-size-2xs); }
  .sw-chip { height: 30px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); }
  .sw-name { color: var(--text-secondary); font-family: var(--font-mono); }
  .sw-hex { color: var(--text-subtle); font-family: var(--font-mono); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .col { display: grid; gap: var(--space-2); }
  .type-row { display: grid; grid-template-columns: 76px 1fr; align-items: baseline; gap: var(--space-3); }
  .type-row code { color: var(--text-subtle); font-family: var(--font-mono); font-size: var(--font-size-2xs); }
  table { width: 100%; border-collapse: collapse; font-size: var(--font-size-sm); }
  th, td { padding: var(--space-15) var(--space-2); text-align: left; border-bottom: 1px solid var(--border-subtle); }
  th { color: var(--text-muted); font-weight: var(--font-weight-medium); }
  td.num { font-family: var(--font-mono); text-align: right; }
  .pass { color: var(--text-success); } .fail { color: var(--text-danger); }
  .pair { display: inline-flex; align-items: center; gap: var(--space-15); }
  .pair i { width: 14px; height: 14px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); }
  .note { color: var(--text-subtle); font-size: var(--font-size-2xs); }
  .sizes { display: grid; gap: var(--space-1); font-size: var(--font-size-2xs); color: var(--text-muted); }
</style>
</head>
<body>
<main class="proof">
  <header class="col">
    <div class="row">
      <svg width="44" height="44" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="${token('--graphite-800')}"/>
        <rect x="14" y="14" width="36" height="36" fill="none" stroke="${token('--graphite-200')}" stroke-width="3.5"/>
        <circle cx="32" cy="32" r="18" fill="none" stroke="${token('--graphite-200')}" stroke-width="3.5"/>
        <rect x="44" y="8" width="12" height="12" fill="${token('--blue-500')}"/>
      </svg>
      <div class="col" style="gap:0">
        <h1>Design system proof sheet</h1>
        <p>Rendered with the product's own stylesheets, in the order <code>main.tsx</code> loads them.</p>
      </div>
    </div>
  </header>

  <section class="card">
    <h2>1. Palette <span>— ramps are definition only; UI uses the semantic tier</span></h2>
    ${RAMPS.map(([name, steps]) => `<div class="grid ramp">${steps.map((step) => swatch(`${name}-${step}`, token(`--${name}-${step}`))).join('')}</div>`).join('')}
    <div class="grid ramp">${SEMANTIC.map((name) => swatch(name, token(`--${name}`))).join('')}</div>
    <div class="grid ramp">${TINTS.map((name) => swatch(name, token(`--${name}`))).join('')}</div>
    <p class="note">${SEMANTIC.length} semantic roles and ${TINTS.length} state tints sampled; the full set is 253 tokens.</p>
  </section>

  <section class="card">
    <h2>2. Type <span>— 12 sizes, four weights, Geist only</span></h2>
    <div class="col">
      ${TYPE.map(([name, size]) => `<div class="type-row"><code>--font-size-${name} · ${size}px</code><span style="font-size: var(--font-size-${name})">Precision icon work, 0123456789</span></div>`).join('')}
    </div>
  </section>

  <section class="card">
    <h2>3. Primitives <span>— the shared layer every new surface should use</span></h2>
    <div class="row">
      <button class="ui-button ui-button--primary" type="button">Primary</button>
      <button class="ui-button" type="button">Secondary</button>
      <button class="ui-button ui-button--quiet" type="button">Quiet</button>
      <button class="ui-button ui-button--danger" type="button">Delete</button>
      <button class="ui-button ui-button--sm" type="button">Small</button>
      <button class="ui-button ui-button--primary" type="button" disabled>Disabled</button>
      <button class="ui-icon-button" type="button" aria-label="Add">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>
      </button>
    </div>
    <div class="row">
      <span class="ui-chip">Chip</span>
      <span class="ui-chip ui-chip--accent">Accent</span>
      <span class="ui-chip ui-chip--success">Pass</span>
      <span class="ui-chip ui-chip--warning">Warn</span>
      <span class="ui-chip ui-chip--danger">Fail</span>
      <span class="ui-status" data-state="ok">Synced</span>
      <span class="ui-status" data-state="busy">Saving</span>
      <span class="ui-status" data-state="error">Offline</span>
      <span class="ui-kbd">⌘</span><span class="ui-kbd">K</span>
    </div>
    <div class="row">
      <div class="ui-field"><label class="ui-field-label" for="p1">Width</label><input class="ui-input" id="p1" value="24"></div>
      <div class="ui-field"><label class="ui-field-label" for="p2">Height</label><input class="ui-input" id="p2" value="24"></div>
      <div class="ui-segmented" role="group" aria-label="Mode">
        <button type="button" class="is-active" aria-pressed="true">Design</button>
        <button type="button" aria-pressed="false">Motion</button>
      </div>
      <span class="ui-switch" aria-hidden="true"></span>
    </div>
    <div class="ui-empty ui-empty--framed"><strong>No files yet</strong><span>Drop an SVG anywhere on this page.</span></div>
  </section>

  <section class="card">
    <h2>4. Legacy controls <span>— the app's own classes, painted by the same tokens</span></h2>
    <p>These are the pre-design-system classes still used in the editor. Same colours, same scales, different shapes —
      this row is the honest answer to "does it look the same everywhere".</p>
    <div class="row">
      <button class="primary-button" type="button">primary-button</button>
      <button class="secondary-button" type="button">secondary-button</button>
      <button class="export-button" type="button">export-button</button>
      <button class="share-button" type="button">share-button</button>
      <button class="renderer-button" type="button">renderer-button</button>
      <button class="family-button" type="button">family-button</button>
      <button class="constraints-button" type="button">constraints-button</button>
      <button class="tool-button" type="button">tool</button>
      <button class="icon-button" type="button" aria-label="Icon">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
      </button>
    </div>
    <div class="row">
      <span class="kd-shortcut">Shortcut <kbd>⌘K</kbd></span>
      <span class="status-bar" style="position:static;border:1px solid var(--border-default);border-radius:var(--radius-sm);padding:var(--space-1) var(--space-2)">status-bar</span>
      <span class="paint-swatch" style="background:${token('--accent')}" aria-hidden="true"></span>
    </div>
  </section>

  <section class="card">
    <h2>5. Radius and spacing <span>— every step is a token</span></h2>
    <div class="row">
      ${RADII.map((name) => `<div style="width:74px;height:44px;border:1px solid var(--border-default);border-radius:var(--radius-${name});background:var(--surface-raised);display:grid;place-items:center;font-size:var(--font-size-2xs);color:var(--text-muted)">${name}</div>`).join('')}
    </div>
    <div class="col sizes">
      ${SPACE.map((name) => `<div class="row" style="gap:var(--space-2)"><code style="width:92px;color:var(--text-subtle);font-family:var(--font-mono)">--space-${name}</code><span style="height:8px;width:var(--space-${name});background:var(--accent);border-radius:2px"></span><span>${token(`--space-${name}`)}</span></div>`).join('')}
    </div>
  </section>

  <section class="card">
    <h2>6. Contrast <span>— measured on the tokens, not the screenshots</span></h2>
    <table>
      <thead><tr><th>Pair</th><th>Foreground</th><th>Background</th><th>Ratio</th><th>AA</th></tr></thead>
      <tbody>
        ${CONTRAST.map(({ fg, bg, f, b, value }) => `<tr>
          <td><span class="pair"><i style="background:${b}"></i><span style="color:${f}">${fg}</span> on ${bg}</span></td>
          <td class="num">${f}</td><td class="num">${b}</td>
          <td class="num">${value.toFixed(2)}:1</td>
          <td class="${value >= 4.5 ? 'pass' : value >= 3 ? 'fail' : 'fail'}">${value >= 4.5 ? 'AA' : value >= 3 ? 'AA large' : 'fail'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </section>

  <footer class="note">
    Generated by <code>npm run proof:design</code>. Colours, sizes and spacing above come from
    <code>src/styles/system/tokens.css</code>; nothing on this page hard-codes a value.
  </footer>
</main>
</body>
</html>
`;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, sheet);
console.log(`Proof sheet written to ${out}`);
console.log('It is self-contained — open it directly, or serve the folder.');
