import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = new URL('../audit/', import.meta.url);
await mkdir(directory, { recursive: true });
const audits = {
  design: { prefix: 'design-sidebar', file: 'design-sidebar-browser.js' },
  review: { prefix: 'review', file: 'review-browser.js' },
};
const { prefix, file } = audits[process.argv[2]] ?? { prefix: 'browser', file: 'browser-audit.js' };
const code = (await readFile(new URL(`./${file}`, import.meta.url), 'utf8'))
  .replace('__PROJECT_ROOT__', JSON.stringify(root.replace(/\/$/, '')));
const result = spawnSync('playwright-cli', ['-s=arena', 'run-code', code], {
  cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 20 * 1024 * 1024,
});
if (result.error) {
  console.error('Browser audit requires the preinstalled Playwright CLI and an open arena session.');
  console.error(result.error.message);
  process.exit(1);
}
await writeFile(new URL(`${prefix}-run.log`, directory), `${result.stdout}\n${result.stderr}`);
const match = /### Result\n([\s\S]*?)\n### Ran/.exec(result.stdout);
if (!match) { console.error(result.stdout, result.stderr); process.exit(1); }
const report = JSON.parse(match[1]);
await writeFile(new URL(`${prefix}-results.json`, directory), `${JSON.stringify(report, null, 2)}\n`);
for (const test of report.results) console.log(`${test.status.toUpperCase()}: ${test.name ?? test.message}`);
console.log(`Browser checks: ${report.passed} passed, ${report.failed} failed.`);
console.log(`Accessibility variants checked: ${Object.keys(report.accessibility).join(', ')}`);
if (report.failed) console.error(JSON.stringify(report, null, 2));
process.exit(result.status || (report.failed ? 1 : 0));
