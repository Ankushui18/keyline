#!/usr/bin/env node
/**
 * Repository documentation check.
 *
 * 1. Every relative link and image in the Markdown docs must resolve on disk.
 * 2. Every file referenced by the repository map must exist.
 * 3. With --results <vitest.json>, the published test counts must match the
 *    suite that actually ran, so README badges cannot silently drift.
 *
 * Dependency-free on purpose: it runs in CI before/after tests with plain Node.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const problems = [];
const checkedLinks = new Set();

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', 'audit', 'coverage', 'solver/target'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function stripAnchor(target) {
  return target.split('#')[0].split('?')[0];
}

const files = await walk(root);
const markdown = files.filter((file) => file.endsWith('.md'));

for (const file of markdown) {
  const text = await readFile(file, 'utf8');
  const links = [
    ...text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
    ...text.matchAll(/(?:src|href)="([^"]+)"/g),
  ].map((match) => match[1]);

  for (const raw of links) {
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(raw)) continue;
    const target = stripAnchor(raw.replace(/^\.\//, ''));
    if (!target) continue;
    if (target.startsWith('/')) {
      problems.push(`${relative(root, file)}: root-absolute link "${raw}" will break on GitHub`);
      continue;
    }
    const resolved = resolve(dirname(file), target);
    checkedLinks.add(relative(root, resolved));
    if (!(await exists(resolved))) {
      problems.push(`${relative(root, file)}: link target not found: ${raw}`);
    }
  }
}

const required = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  '.gitignore',
  'docs/ARCHITECTURE.md',
  'docs/USER-GUIDE.md',
  'docs/DEVELOPMENT.md',
  'docs/TESTING.md',
  'docs/COLLABORATION.md',
  'docs/FAQ.md',
  'docs/AUDIT.md',
  'docs/assets/banner.svg',
  'docs/assets/data-flow.svg',
  'server/collaboration-server.mjs',
  'scripts/run-with-collaboration.mjs',
  'scripts/test-solver.mjs',
  'scripts/test-collaboration.mjs',
  'solver/src/lib.rs',
  'solver/pkg/vector_solver_bg.wasm',
];
for (const path of required) {
  if (!(await exists(join(root, path)))) problems.push(`required file is missing: ${path}`);
}

// Generated artefacts must not be tracked. `tsc -b` and `vite` recreate these
// on disk during a normal build, so only Git's index is authoritative here.
const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
if (tracked.status === 0) {
  for (const file of tracked.stdout.split('\0').filter(Boolean)) {
    if (/\.tsbuildinfo$/.test(file) || /(^|\/)vite\.log$/.test(file)) {
      problems.push(`generated artefact is tracked by Git: ${file}`);
    }
  }
}

const resultsFlag = process.argv.indexOf('--results');
if (resultsFlag !== -1) {
  const resultsPath = process.argv[resultsFlag + 1];
  if (!resultsPath) {
    problems.push('--results requires a path to a Vitest JSON report');
  } else {
    try {
      const report = JSON.parse(await readFile(resolve(process.cwd(), resultsPath), 'utf8'));
      const tests = report.numTotalTests;
      // `numTotalTestSuites` counts describe blocks; testResults is one entry per file.
      const suites = report.testResults?.length ?? report.numTotalTestSuites;
      const readme = await readFile(join(root, 'README.md'), 'utf8');
      const testing = await readFile(join(root, 'docs/TESTING.md'), 'utf8');
      const badge = /tests-(\d+)(?:%20|\s)passing/.exec(readme);
      if (!badge) problems.push('README.md: missing "tests-<n> passing" badge');
      else if (Number(badge[1]) !== tests) problems.push(`README.md badge says ${badge[1]} tests, suite ran ${tests}`);
      if (!readme.includes(`**${tests} tests**`) && !readme.includes(`${tests} tests`)) {
        problems.push(`README.md: does not mention the real test count (${tests})`);
      }
      if (!testing.includes(`${tests} tests`)) problems.push(`docs/TESTING.md: does not mention the real test count (${tests})`);
      if (suites && !testing.includes(`${suites} test files`)) {
        problems.push(`docs/TESTING.md: does not mention the real test-file count (${suites})`);
      }
      console.log(`Test report: ${tests} tests in ${suites ?? '?'} files.`);
    } catch (error) {
      problems.push(`could not read Vitest report: ${error.message}`);
    }
  }
}

if (problems.length > 0) {
  console.error('Documentation check failed:\n');
  for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Documentation check passed: ${markdown.length} Markdown files, ${checkedLinks.size} local link targets.`);
