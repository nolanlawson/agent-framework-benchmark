#!/usr/bin/env node
// Measures one implementation: node bench/measure.mjs <appDir> <outDir> [--runs N] [--skip-build]
// Writes <outDir>/results.json, plus the first Lighthouse report of each URL.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import { startStack, APP_ORIGIN, APP_PORT, TEMPLATE } from './stack.mjs';

const args = process.argv.slice(2);
const [appDirArg, outArg] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs');
if (!appDirArg || !outArg) {
  console.error('Usage: measure.mjs <appDir> <outDir> [--runs N] [--skip-build]');
  process.exit(1);
}
const RUNS = Number(args[args.indexOf('--runs') + 1]) || 5;
const appDir = path.resolve(appDirArg);
const out = path.resolve(outArg);
fs.mkdirSync(path.join(out, 'lighthouse'), { recursive: true });

const CHROME = chromium.executablePath();
// Completed with the flag that makes Chrome trust Caddy's certificates once the stack is up.
const CHROME_FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu'];
const LH_URLS = {
  home: '/',
  'home-filtered': '/?type=fire&generation=generation-i',
  pokemon: '/pokemon/pikachu',
  move: '/moves/thunderbolt',
  ability: '/abilities/static',
  type: '/types/fire',
};
const AUDITS = {
  lcp: 'largest-contentful-paint',
  fcp: 'first-contentful-paint',
  tbt: 'total-blocking-time',
  cls: 'cumulative-layout-shift',
  si: 'speed-index',
  ttfb: 'server-response-time',
  bytes: 'total-byte-weight',
};

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function summarizeLhr(lhr) {
  const metrics = Object.fromEntries(Object.entries(AUDITS).map(([k, id]) => [k, lhr.audits[id]?.numericValue ?? null]));
  const items = lhr.audits['resource-summary']?.details?.items ?? [];
  const bytesOf = (type) => items.find((i) => i.resourceType === type)?.transferSize ?? 0;
  const countOf = (type) => items.find((i) => i.resourceType === type)?.requestCount ?? 0;
  return {
    ...metrics,
    scriptBytes: bytesOf('script'),
    documentBytes: bytesOf('document'),
    imageBytes: bytesOf('image'),
    requests: countOf('total'),
    performance: lhr.categories.performance?.score ?? null,
    accessibility: lhr.categories.accessibility?.score ?? null,
  };
}

async function runLighthouse() {
  const results = {};
  // Lighthouse's default (mobile) settings only. The desktop preset mostly measured the layout
  // shift caused by Linux scrollbars appearing, which macOS users never see.
  for (const [page, urlPath] of Object.entries(LH_URLS)) {
    // Warm the app's server-side caches right before this URL's runs, so even short-lived caches
    // are warm: the measured visit is a new user on a site other people already use.
    for (let i = 0; i < 2; i++) await fetch(`http://localhost:${APP_PORT}${urlPath}`).then((r) => r.arrayBuffer()).catch(() => {});
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const chrome = await chromeLauncher.launch({ chromePath: CHROME, chromeFlags: CHROME_FLAGS });
      try {
        const { lhr } = await lighthouse(APP_ORIGIN + urlPath, {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['performance', 'accessibility'],
        });
        if (lhr.runtimeError) throw new Error(`${urlPath}: ${lhr.runtimeError.message}`);
        runs.push(summarizeLhr(lhr));
        if (i === 0) fs.writeFileSync(path.join(out, 'lighthouse', `${page}-mobile.json`), JSON.stringify(lhr));
      } finally {
        await chrome.kill();
      }
    }
    const summary = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, round(median(runs.map((r) => r[k])), 3)]));
    results[`${page}/mobile`] = { median: summary, runs };
    console.log(`  ${page.padEnd(14)} perf ${summary.performance}  LCP ${round(summary.lcp)}ms  TBT ${round(summary.tbt)}ms  CLS ${summary.cls}  JS ${round(summary.scriptBytes / 1024)}KiB`);
  }
  return results;
}

// ----- Code stats -----

// Lines of code the agent wrote: non-blank lines in the source files the app tracks (comments
// included). Not counted: JSON, lockfiles, tests, generated files, and verbatim copies of the
// provided design files (every app copies design/tokens.css).
function codeStats() {
  const files = spawnSync('git', ['-c', 'safe.directory=*', 'ls-files', '--cached', '--others', '--exclude-standard', '.'], { cwd: appDir, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((f) => f && fs.existsSync(path.join(appDir, f)));
  const designDir = path.join(TEMPLATE, 'design');
  const provided = new Set(fs.readdirSync(designDir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(designDir, f), 'utf8')));
  let lines = 0;
  for (const f of files) {
    if (!/\.([cm]?[jt]sx?|vue|svelte|astro|html|css|scss)$/.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) continue;
    const text = fs.readFileSync(path.join(appDir, f), 'utf8');
    if (provided.has(text) || /automatically generated|auto-generated|@generated|do not edit/i.test(text.slice(0, 500))) continue;
    lines += text.split('\n').filter((l) => l.trim()).length;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  // Versions actually installed for the measured build (not just the ranges in package.json).
  const installed = {};
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    try {
      installed[dep] = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', dep, 'package.json'), 'utf8')).version;
    } catch {
      installed[dep] = null;
    }
  }
  return { sourceLines: lines, installed };
}

// ----- Main -----

const results = { appDir, measuredAt: new Date().toISOString(), runs: RUNS };
console.log(`Measuring ${appDir}`);
const stack = await startStack(appDir, { build: !args.includes('--skip-build') });
CHROME_FLAGS.push(stack.chromeCertFlag);
try {
  console.log('Lighthouse:');
  results.lighthouse = await runLighthouse();
  results.code = codeStats();
} finally {
  await stack.stop();
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Wrote ${path.join(out, 'results.json')}`);
