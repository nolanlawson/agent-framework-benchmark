#!/usr/bin/env node
// Builds and starts the app, then runs the Playwright acceptance tests against it.
//
// 1. Starts the API with the normal data and runs `npm install` + `npm run build` in the app.
// 2. Restarts the API with tests/fixtures/live-data-overlay.json, so the running app sees
//    data that differs from build time.
// 3. Starts the app with `npm start` and runs Playwright. Extra arguments go to Playwright.
//
// Env: APP_DIR (default ./app), API_PORT (default 9100), APP_PORT (default 3100),
//      SKIP_BUILD=1 to reuse the previous install and build.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.resolve(ROOT, process.env.APP_DIR ?? 'app');
const API_PORT = Number(process.env.API_PORT ?? 9100);
const APP_PORT = Number(process.env.APP_PORT ?? 3100);
const API_BASE_URL = `http://localhost:${API_PORT}`;
const APP_URL = `http://localhost:${APP_PORT}`;
const OVERLAY = path.join(ROOT, 'tests/fixtures/live-data-overlay.json');

const children = new Set();
function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  const log = [];
  const keep = (chunk) => {
    log.push(chunk);
    if (log.length > 200) log.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.name = name;
  child.log = () => Buffer.concat(log).toString();
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, 5000).unref();
  });
}

async function cleanup() {
  await Promise.all([...children].map(stop));
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await cleanup();
    process.exit(130);
  });
}

async function waitFor(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${child.name} exited with code ${child.exitCode}:\n${child.log()}`);
    try {
      const res = await fetch(url);
      await res.body?.cancel();
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${child.name} did not respond at ${url} within ${timeoutMs / 1000}s:\n${child.log()}`);
}

function run(cmd, args, opts) {
  console.log(`$ ${cmd} ${args.join(' ')}  (in ${path.relative(ROOT, opts.cwd) || '.'})`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`);
}

function startApi(overlay) {
  const env = { ...process.env, PORT: String(API_PORT), PUBLIC_URL: API_BASE_URL, LATENCY_MS: '0' };
  if (overlay) env.API_OVERLAY = overlay;
  else delete env.API_OVERLAY;
  return start('API server', process.execPath, [path.join(ROOT, 'api/server.mjs')], { cwd: ROOT, env });
}

let exitCode = 1;
try {
  if (!fs.existsSync(path.join(ROOT, 'data/.done'))) run(path.join(ROOT, 'scripts/setup-data.sh'), [], { cwd: ROOT });
  if (!fs.existsSync(path.join(APP_DIR, 'package.json'))) throw new Error(`No app found: ${APP_DIR}/package.json is missing`);

  const appEnv = { ...process.env, API_BASE_URL, PORT: String(APP_PORT), NODE_ENV: 'production' };

  let api = startApi(null);
  await waitFor(`${API_BASE_URL}/api/v2/`, api, 30_000);
  if (process.env.SKIP_BUILD !== '1') {
    run('npm', ['install', '--no-audit', '--no-fund', '--include=dev'], { cwd: APP_DIR, env: { ...appEnv, NODE_ENV: 'development' } });
    run('npm', ['run', 'build'], { cwd: APP_DIR, env: appEnv });
  }
  await stop(api);

  api = startApi(OVERLAY);
  await waitFor(`${API_BASE_URL}/api/v2/`, api, 30_000);

  const app = start('App', 'npm', ['start'], { cwd: APP_DIR, env: appEnv });
  await waitFor(APP_URL, app, 60_000);

  const pw = spawnSync(
    'npx',
    ['playwright', 'test', '--config', path.join(ROOT, 'tests/playwright.config.mjs'), ...process.argv.slice(2)],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, BASE_URL: APP_URL, API_BASE_URL } },
  );
  exitCode = pw.status ?? 1;
  if (exitCode !== 0 && app.exitCode !== null) console.error(`\nThe app exited during the tests:\n${app.log()}`);
} catch (err) {
  console.error(`\n${err.message}`);
} finally {
  await cleanup();
}
process.exit(exitCode);
