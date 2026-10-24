#!/usr/bin/env node
// Runs the Pokédex framework benchmark end to end with Podman:
//
//   1. Builds three images from scratch: pokedex-base (Ubuntu, Node, Chromium, the exported
//      template repo and its data), pokedex-agent (+ Claude Code, agent-browser) and
//      pokedex-measure (+ Caddy, Lighthouse and the measurement scripts).
//   2. For every framework x iteration, runs one agent in its own pokedex-agent container.
//      The agent gets the prompt from frameworks.mjs and nothing else. When it stops, the
//      container restores the original tests and runs them.
//   3. Measures each agent's app, one at a time, in a pokedex-measure container.
//   4. Writes runs/<id>/report.md.
//
// Nothing here runs agent-written code on the host: agents and their apps only ever run
// inside containers. The host needs Podman and Node 20+.
//
// Usage:
//   node bench/run.mjs --frameworks=vanilla,astro [--iterations=1] [options]
//   node bench/run.mjs --measure-only=runs/<id>     re-measure and re-report an earlier run
//   node bench/run.mjs --report-only=runs/<id>      only regenerate report.md
// Options:
//   --frameworks=a,b|all    frameworks to test (keys in bench/frameworks.mjs)
//   --iterations=N          agent runs per framework (default 1)
//   --parallel=N            agent containers at once (default 1); measurement is always serial
//   --model=ID              model passed to `claude --model` (default: Claude Code's default)
//   --claude-version=V      Claude Code npm version for the agent image (default latest)
//   --cpus=N --memory=SIZE  per-container limits (default 4 and 8g)
//   --agent-timeout=MIN     stop an agent after this many minutes (default 240)
//   --lighthouse-runs=N     Lighthouse runs per URL and form factor (default 5)
//   --no-cache              rebuild images without Podman's layer cache (pulls fresh base)
//   --skip-image-build      reuse existing images
//   --no-measure            stop after the agent runs
//   --out=DIR               where run directories go (default ./runs)
//
// Credentials, in order of preference: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from
// the environment (`claude setup-token` creates the latter), otherwise the contents of
// ~/.claude/.credentials.json. They're handed to containers through an environment
// variable, never written to the run directory.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORKS, prompt } from './frameworks.mjs';
import { writeReport } from './report.mjs';

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BENCH, '..');
const IMAGES = { base: 'pokedex-base', agent: 'pokedex-agent', measure: 'pokedex-measure' };
// Exact Node version for every container (npm comes bundled with it). The root .nvmrc links here.
const NODE_VERSION = fs.readFileSync(path.join(ROOT, 'template/.nvmrc'), 'utf8').trim();

// ---------- Options ----------

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw new Error(`Unexpected argument: ${arg}`);
    opts[m[1]] = m[2] ?? true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const num = (key, fallback) => {
  if (opts[key] === undefined) return fallback;
  const n = Number(opts[key]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive number`);
  return n;
};
const config = {
  iterations: num('iterations', 1),
  parallel: num('parallel', 1),
  cpus: num('cpus', 4),
  memory: opts.memory ?? '8g',
  agentTimeoutMin: num('agent-timeout', 240),
  lighthouseRuns: num('lighthouse-runs', 5),
  model: opts.model ?? null,
  claudeVersion: opts['claude-version'] ?? 'latest',
};

// ---------- Helpers ----------

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

function sh(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`);
  return result;
}

// Runs a command with output going to a log file; resolves with the exit code.
function runLogged(cmd, args, logFile, { env, timeoutMs, onTimeout } = {}) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, { stdio: ['ignore', out, out], env });
    let timer;
    if (timeoutMs) timer = setTimeout(() => onTimeout?.(), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      fs.closeSync(out);
      resolve(code ?? 1);
    });
  });
}

// Rootless Podman: map the host user to the container's "agent" user (uid 1000) so files
// written to mounted directories are owned by you on the host.
// Rootful Podman (running as root) can't do that, so the directories are opened up instead.
const rootful = process.getuid?.() === 0;
const userns = rootful ? [] : ['--userns=keep-id:uid=1000,gid=1000'];
const writableDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  if (rootful) fs.chmodSync(dir, 0o777);
};

function preflight() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node 20+ required (found ${process.versions.node})`);
  if (process.versions.node !== NODE_VERSION) {
    log(`Note: host Node is ${process.versions.node}; containers use ${NODE_VERSION} (.nvmrc). Run \`nvm use\` to match.`);
  }
  const podman = spawnSync('podman', ['--version'], { encoding: 'utf8' });
  if (podman.status !== 0) throw new Error('podman not found on PATH');
  return podman.stdout.trim();
}

function credentialsEnv() {
  if (process.env.ANTHROPIC_API_KEY) return { name: 'ANTHROPIC_API_KEY', env: {} };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { name: 'CLAUDE_CODE_OAUTH_TOKEN', env: {} };
  const file = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(file)) {
    return { name: 'HOST_CLAUDE_CREDENTIALS', env: { HOST_CLAUDE_CREDENTIALS: fs.readFileSync(file, 'utf8') } };
  }
  throw new Error('No Claude credentials: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or log in with `claude` first');
}

// ---------- Step 1: images ----------

function buildImages(runDir) {
  const ctx = path.join(runDir, '.build');
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(ctx, { recursive: true });
  sh(path.join(BENCH, 'container/export-template.sh'), [path.join(ctx, 'work')]);
  const cacheArgs = opts['no-cache'] ? ['--no-cache', '--pull=always'] : [];
  const build = (image, file, context, buildArgs = []) => {
    log(`Building ${image}`);
    sh('podman', ['build', ...cacheArgs, '-t', image, '-f', file, ...buildArgs, context]);
  };
  build(IMAGES.base, path.join(BENCH, 'container/Containerfile.base'), ctx, ['--build-arg', `NODE_VERSION=${NODE_VERSION}`]);
  build(IMAGES.agent, path.join(BENCH, 'container/Containerfile.agent'), path.join(BENCH, 'container'), [
    '--build-arg', `BASE=${IMAGES.base}`,
    '--build-arg', `CLAUDE_CODE_VERSION=${config.claudeVersion}`,
  ]);
  build(IMAGES.measure, path.join(BENCH, 'container/Containerfile.measure'), BENCH, ['--build-arg', `BASE=${IMAGES.base}`]);
  fs.rmSync(ctx, { recursive: true, force: true });
}

// ---------- Step 2: agents ----------

async function runAgent(runId, iterDir, framework, credentials) {
  const out = path.join(iterDir, 'agent');
  writableDir(out);
  const name = `pokedex-${runId}-${path.basename(iterDir)}`;
  const args = [
    'run', '--rm', '--name', name, ...userns,
    `--cpus=${config.cpus}`, `--memory=${config.memory}`,
    // Agents must use the local API, so the real one is unreachable.
    '--add-host=pokeapi.co:127.0.0.1', '--add-host=www.pokeapi.co:127.0.0.1',
    '-v', `${out}:/out:Z`,
    '-e', 'FRAMEWORK', '-e', 'PROMPT', '-e', 'MODEL', '-e', credentials.name,
    IMAGES.agent,
  ];
  const env = {
    ...process.env,
    ...credentials.env,
    FRAMEWORK: framework,
    PROMPT: prompt(FRAMEWORKS[framework]),
    MODEL: config.model ?? '',
  };
  log(`Agent start: ${path.basename(iterDir)}`);
  const code = await runLogged('podman', args, path.join(iterDir, 'container.log'), {
    env,
    timeoutMs: config.agentTimeoutMin * 60_000,
    onTimeout: () => {
      log(`Agent timeout: ${path.basename(iterDir)} after ${config.agentTimeoutMin} min`);
      fs.writeFileSync(path.join(iterDir, 'TIMED_OUT'), `${config.agentTimeoutMin} minutes\n`);
      spawnSync('podman', ['stop', '-t', '10', name]);
    },
  });
  log(`Agent done:  ${path.basename(iterDir)} (container exit ${code})`);
}

async function runAgents(runId, runDir, frameworks) {
  const credentials = credentialsEnv();
  const queue = frameworks.flatMap((fw) =>
    Array.from({ length: config.iterations }, (_, i) => ({ fw, dir: path.join(runDir, `${fw}-${i + 1}`) })),
  );
  const workers = Array.from({ length: Math.min(config.parallel, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await runAgent(runId, job.dir, job.fw, credentials);
  });
  await Promise.all(workers);
}

// ---------- Step 3: measurement ----------

async function measure(iterDir) {
  const tarball = path.join(iterDir, 'agent/repo.tar.gz');
  const repo = path.join(iterDir, 'repo');
  const results = path.join(iterDir, 'measure');
  fs.rmSync(results, { recursive: true, force: true });
  writableDir(results);
  const fail = (msg) => {
    fs.writeFileSync(path.join(results, 'error.txt'), `${msg}\n`);
    log(`Measure failed: ${path.basename(iterDir)}: ${msg}`);
  };
  if (!fs.existsSync(tarball)) return fail('no repo.tar.gz (the agent run did not finish)');
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo);
  sh('tar', ['-xzf', tarball, '-C', repo]);
  if (rootful) sh('chmod', ['-R', 'a+rwX', repo]);
  if (!fs.existsSync(path.join(repo, 'app/package.json'))) return fail('no app/package.json');

  log(`Measure start: ${path.basename(iterDir)}`);
  const code = await runLogged(
    'podman',
    [
      'run', '--rm', ...userns, `--cpus=${config.cpus}`, `--memory=${config.memory}`,
      '-v', `${repo}:/repo:Z`, '-v', `${results}:/results:Z`,
      IMAGES.measure, '/repo/app', '/results', '--runs', String(config.lighthouseRuns),
    ],
    path.join(results, 'measure.log'),
  );
  if (code !== 0) return fail(`measure container exited with ${code}; see measure/measure.log`);
  log(`Measure done:  ${path.basename(iterDir)}`);
}

async function measureAll(runDir) {
  const dirs = fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-\d+$/.test(d.name))
    .map((d) => path.join(runDir, d.name))
    .sort();
  for (const dir of dirs) await measure(dir);
}

// ---------- Main ----------

async function main() {
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n\n')[0].replace(/^#!.*\n/, '').replace(/^\/\/ ?/gm, ''));
    return;
  }
  if (opts['report-only']) {
    writeReport(path.resolve(opts['report-only']));
    log(`Report: ${path.join(path.resolve(opts['report-only']), 'report.md')}`);
    return;
  }

  const podmanVersion = preflight();

  if (opts['measure-only']) {
    const runDir = path.resolve(opts['measure-only']);
    if (!opts['skip-image-build']) buildImages(runDir);
    await measureAll(runDir);
    writeReport(runDir);
    log(`Report: ${path.join(runDir, 'report.md')}`);
    return;
  }

  if (!opts.frameworks) throw new Error(`--frameworks is required. Choose from: ${Object.keys(FRAMEWORKS).join(', ')}, or all`);
  const frameworks = opts.frameworks === 'all' ? Object.keys(FRAMEWORKS) : String(opts.frameworks).split(',').map((s) => s.trim());
  const unknown = frameworks.filter((f) => !FRAMEWORKS[f]);
  if (unknown.length) throw new Error(`Unknown framework(s): ${unknown.join(', ')}. Choose from: ${Object.keys(FRAMEWORKS).join(', ')}`);

  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const runDir = path.resolve(opts.out ?? path.join(ROOT, 'runs'), runId);
  fs.mkdirSync(runDir, { recursive: true });
  const harnessCommit = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const harnessDirty = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() !== '';
  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    JSON.stringify(
      {
        ...config,
        frameworks,
        prompts: Object.fromEntries(frameworks.map((f) => [f, prompt(FRAMEWORKS[f])])),
        startedAt: new Date().toISOString(),
        nodeVersion: NODE_VERSION,
        harnessCommit,
        harnessDirty,
        podman: podmanVersion,
        host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30) },
      },
      null,
      2,
    ),
  );
  log(`Run ${runId}: ${frameworks.join(', ')} x ${config.iterations} -> ${runDir}`);

  if (!opts['skip-image-build']) buildImages(runDir);
  await runAgents(runId, runDir, frameworks);
  if (!opts['no-measure']) await measureAll(runDir);
  writeReport(runDir);
  log(`Report: ${path.join(runDir, 'report.md')}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
