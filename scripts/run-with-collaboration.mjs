import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const preview = args[0] === 'preview';
if (preview) args.shift();
const children = new Set();
let stopping = false;
let startupTimeout;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimeout);
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  if (!children.size) { process.exit(code); return; }
  const force = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 5000);
  force.unref();
}

function launch(script, parameters, ipc = false) {
  const child = spawn(process.execPath, [script, ...parameters], {
    cwd: root,
    env: process.env,
    stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
  });
  children.add(child);
  child.once('error', (error) => { console.error(error.message); stop(1); });
  child.once('exit', (code) => {
    children.delete(child);
    if (!stopping) stop(code || 1);
    if (!children.size) process.exit(process.exitCode ?? 0);
  });
  return child;
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
const relay = launch('server/collaboration-server.mjs', [], true);
startupTimeout = setTimeout(() => { console.error('Collaboration relay did not become ready.'); stop(1); }, 15_000);
relay.once('message', (message) => {
  if (message?.type !== 'ready' || stopping) return;
  clearTimeout(startupTimeout);
  launch('node_modules/vite/bin/vite.js', [...(preview ? ['preview'] : []), '--host', '0.0.0.0', '--strictPort', ...args]);
});
