// Starts an app in production mode behind Caddy (HTTPS, HTTP/2, zstd/gzip) together with
// the API, the way it would be deployed. Used by measure.mjs.
//
//   https://app.localhost:8443  -> app on :3200
//   https://api.localhost:8444  -> API on :9200 (normal data, no overlay, no latency)

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE = process.env.TEMPLATE_DIR ?? path.resolve(BENCH, '../template');
export const APP_ORIGIN = 'https://app.localhost:8443';
export const API_ORIGIN = 'https://api.localhost:8444';
export const APP_PORT = 3200;
const API_PORT = 9200;
const CADDY_DIR = path.join(BENCH, '.caddy');
const CADDY_ROOT_CERT = path.join(CADDY_DIR, 'pki/authorities/local/root.crt');

const CADDYFILE = `{
  admin off
  local_certs
  skip_install_trust
  auto_https disable_redirects
  storage file_system ${CADDY_DIR}
}
app.localhost:8443 {
  encode zstd gzip
  reverse_proxy localhost:${APP_PORT}
}
api.localhost:8444 {
  encode zstd gzip
  reverse_proxy localhost:${API_PORT}
}
`;

function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  const log = [];
  child.stdout.on('data', (c) => log.push(c));
  child.stderr.on('data', (c) => log.push(c));
  child.label = name;
  child.log = () => Buffer.concat(log).toString();
  return child;
}

function kill(child) {
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

async function waitFor(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${child.label} exited (${child.exitCode}):\n${child.log()}`);
    try {
      const res = await fetch(url);
      await res.body?.cancel();
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${child.label} not ready at ${url}:\n${child.log()}`);
}

// Starts Caddy and the API, installs and builds the app, then starts it.
// Returns { buildMs, stop }.
export async function startStack(appDir, { build = true } = {}) {
  fs.mkdirSync(CADDY_DIR, { recursive: true });
  const caddyfile = path.join(CADDY_DIR, 'Caddyfile');
  fs.writeFileSync(caddyfile, CADDYFILE);
  const procs = [];
  const stop = () => Promise.all(procs.map(kill));
  try {
    const caddy = start('Caddy', 'caddy', ['run', '--config', caddyfile, '--adapter', 'caddyfile']);
    procs.push(caddy);
    const api = start('API', process.execPath, [path.join(TEMPLATE, 'api/server.mjs')], {
      env: { ...process.env, PORT: String(API_PORT), PUBLIC_URL: API_ORIGIN, LATENCY_MS: '0', API_OVERLAY: '' },
    });
    procs.push(api);
    await waitFor(`http://localhost:${API_PORT}/api/v2/`, api);
    // Caddy creates its local CA on first start; Node needs it to call the API over HTTPS.
    for (let i = 0; i < 40 && !fs.existsSync(CADDY_ROOT_CERT); i++) await new Promise((r) => setTimeout(r, 250));

    const env = {
      ...process.env,
      API_BASE_URL: API_ORIGIN,
      PORT: String(APP_PORT),
      NODE_ENV: 'production',
      NODE_EXTRA_CA_CERTS: CADDY_ROOT_CERT,
    };
    let buildMs = null;
    if (build) {
      const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--include=dev'], {
        cwd: appDir,
        env: { ...env, NODE_ENV: 'development' },
        stdio: 'inherit',
      });
      if (install.status !== 0) throw new Error('npm install failed');
      const t0 = performance.now();
      const result = spawnSync('npm', ['run', 'build'], { cwd: appDir, env, stdio: 'inherit' });
      if (result.status !== 0) throw new Error('npm run build failed');
      buildMs = Math.round(performance.now() - t0);
    }
    const app = start('App', 'npm', ['start'], { cwd: appDir, env });
    procs.push(app);
    await waitFor(`http://localhost:${APP_PORT}/`, app);
    return { buildMs, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
