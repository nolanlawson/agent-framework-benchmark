#!/usr/bin/env node
// Measures one implementation: node bench/measure.mjs <appDir> <outDir> [--runs N] [--skip-build]
// Writes <outDir>/results.json, plus raw Lighthouse reports and screenshots.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import lighthouse, { desktopConfig, startFlow } from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { startStack, APP_ORIGIN, APP_PORT, TEMPLATE } from './stack.mjs';
import { capture, PAGES, VIEWPORTS } from './screenshots.mjs';

const args = process.argv.slice(2);
const [appDirArg, outArg] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs');
if (!appDirArg || !outArg) {
  console.error('Usage: measure.mjs <appDir> <outDir> [--runs N] [--skip-build]');
  process.exit(1);
}
const RUNS = Number(args[args.indexOf('--runs') + 1]) || 5;
const FLOW_RUNS = Math.max(1, Math.ceil(RUNS / 2));
const appDir = path.resolve(appDirArg);
const out = path.resolve(outArg);
fs.mkdirSync(path.join(out, 'lighthouse'), { recursive: true });

const CHROME = chromium.executablePath();
const CHROME_FLAGS = ['--headless=new', '--no-sandbox', '--ignore-certificate-errors', '--disable-gpu'];
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
  for (const [formFactor, config] of [['mobile', undefined], ['desktop', desktopConfig]]) {
    for (const [page, urlPath] of Object.entries(LH_URLS)) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const chrome = await chromeLauncher.launch({ chromePath: CHROME, chromeFlags: CHROME_FLAGS });
        try {
          const { lhr } = await lighthouse(
            APP_ORIGIN + urlPath,
            { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility'] },
            config,
          );
          if (lhr.runtimeError) throw new Error(`${urlPath}: ${lhr.runtimeError.message}`);
          runs.push(summarizeLhr(lhr));
          if (i === 0) fs.writeFileSync(path.join(out, 'lighthouse', `${page}-${formFactor}.json`), JSON.stringify(lhr));
        } finally {
          await chrome.kill();
        }
      }
      const summary = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, round(median(runs.map((r) => r[k])), 3)]));
      results[`${page}/${formFactor}`] = { median: summary, runs };
      console.log(`  ${formFactor.padEnd(7)} ${page.padEnd(14)} perf ${summary.performance}  LCP ${round(summary.lcp)}ms  TBT ${round(summary.tbt)}ms  CLS ${summary.cls}  JS ${round(summary.scriptBytes / 1024)}KiB`);
    }
  }
  return results;
}

// ----- User flow -----

// Runs in the page: collects visible text and elements across open shadow roots.
const DEEP_HELPERS = `
  window.__deep = {
    all(root = document) {
      const out = [];
      const walk = (node) => {
        for (const el of node.querySelectorAll('*')) {
          out.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return out;
    },
    text() {
      return this.all().filter((el) => !el.children.length || el.shadowRoot).map((el) => (el.shadowRoot ? '' : el.textContent)).join(' ').replace(/\\s+/g, ' ');
    },
    link(pathname) {
      return this.all().find((el) => el.tagName === 'A' && new URL(el.href, location.href).pathname === pathname && el.getClientRects().length);
    },
    h1() {
      return this.all().find((el) => el.tagName === 'H1' || (el.getAttribute('role') === 'heading' && el.getAttribute('aria-level') === '1'))?.textContent.trim();
    },
  };
`;

async function deep(page, fn, arg) {
  return page.evaluateHandle(fn, arg);
}

// Latency runs from the start of `action` until `until` holds. An action can return its own
// start time instead (search starts the clock at the last keystroke, not the first).
async function timed(flow, page, label, action, until) {
  await flow.startTimespan({ name: label });
  const start = Date.now();
  const t0 = (await action()) ?? start;
  await page.waitForFunction(until.fn, { timeout: 30_000, polling: 'mutation' }, until.arg);
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 1000));
  await flow.endTimespan();
  return ms;
}

async function runFlowOnce(i) {
  const browser = await puppeteer.launch({ executablePath: CHROME, args: CHROME_FLAGS, acceptInsecureCerts: true });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(DEEP_HELPERS);
    const flow = await startFlow(page, {
      name: 'Pokédex flow',
      config: { extends: 'lighthouse:default', settings: { throttlingMethod: 'devtools', onlyCategories: ['performance'] } },
    });
    const latency = {};

    await flow.navigate(APP_ORIGIN + '/', { name: 'Load home' });
    await page.waitForFunction(() => window.__deep.link('/pokemon/bulbasaur'));

    const search = await deep(page, () => window.__deep.all().find((el) => el.tagName === 'INPUT' && el.type === 'search'));
    latency.search = await timed(
      flow,
      page,
      'Search',
      async () => {
        await search.click();
        await page.keyboard.type('cha', { delay: 100 });
        // "cha" matches more than 7 Pokémon, so the wait below can only end after the last key.
        const lastKey = Date.now();
        await page.keyboard.press('r', { delay: 100 });
        return lastKey;
      },
      { fn: () => /(^|\s)7 Pokémon(\s|$)/.test(window.__deep.text()) && window.__deep.link('/pokemon/pecharunt') },
    );

    const card = await deep(page, () => window.__deep.link('/pokemon/charizard'));
    latency.openPokemon = await timed(flow, page, 'Open Pokémon', () => card.click(), {
      fn: () => window.__deep.h1() === 'Charizard' && /Base stats/.test(window.__deep.text()),
    });

    const header = await deep(page, () =>
      window.__deep.all().find((el) => (el.tagName === 'TH' || el.getAttribute('role') === 'columnheader') && /^\s*Power/.test(el.textContent)),
    );
    await header.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    latency.sortMoves = await timed(
      flow,
      page,
      'Sort moves',
      async () => {
        const target = (await header.$('button')) ?? header;
        await target.click();
      },
      { fn: () => window.__deep.all().some((el) => el.getAttribute('aria-sort') === 'ascending') },
    );

    const select = await deep(page, () => {
      const label = window.__deep.all().find((el) => el.tagName === 'LABEL' && el.textContent.trim() === 'Game');
      return label?.control ?? window.__deep.all().find((el) => el.tagName === 'SELECT' && [...el.options].some((o) => o.text.trim() === 'Sword Shield'));
    });
    latency.changeGame = await timed(
      flow,
      page,
      'Change game',
      () =>
        select.evaluate((el) => {
          el.value = [...el.options].find((o) => o.text.trim() === 'Sword Shield').value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }),
      { fn: () => /game=sword-shield/.test(location.search) && window.__deep.h1() === 'Charizard' && window.__deep.all().some((el) => el.tagName === 'TABLE' || el.getAttribute('role') === 'table') },
    );

    const result = await flow.createFlowResult();
    if (i === 0) fs.writeFileSync(path.join(out, 'lighthouse', 'flow.json'), JSON.stringify(result));
    const steps = Object.fromEntries(
      result.steps.map((s) => [
        s.name,
        {
          inp: s.lhr.audits['interaction-to-next-paint']?.numericValue ?? null,
          tbt: s.lhr.audits['total-blocking-time']?.numericValue ?? null,
          lcp: s.lhr.audits['largest-contentful-paint']?.numericValue ?? null,
          cls: s.lhr.audits['cumulative-layout-shift']?.numericValue ?? null,
        },
      ]),
    );
    return { latency, steps };
  } finally {
    await browser.close();
  }
}

async function runFlows() {
  const runs = [];
  for (let i = 0; i < FLOW_RUNS; i++) runs.push(await runFlowOnce(i));
  const latency = Object.fromEntries(Object.keys(runs[0].latency).map((k) => [k, median(runs.map((r) => r.latency[k]))]));
  const steps = Object.fromEntries(
    Object.keys(runs[0].steps).map((s) => [
      s,
      Object.fromEntries(Object.keys(runs[0].steps[s]).map((k) => [k, round(median(runs.map((r) => r.steps[s][k])), 3)])),
    ]),
  );
  console.log('  flow latency (ms):', latency);
  return { latency, steps, runs };
}

// ----- Visual similarity -----

function compare(a, b) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pad = (img) => {
    const out = new PNG({ width, height });
    out.data.fill(255);
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
    return out;
  };
  const diff = pixelmatch(pad(a).data, pad(b).data, null, width, height, { threshold: 0.1 });
  return diff / (width * height);
}

async function runVisual() {
  const dir = path.join(out, 'screenshots');
  await capture(APP_ORIGIN, dir);
  const scores = {};
  for (const page of Object.keys(PAGES)) {
    for (const vp of Object.keys(VIEWPORTS)) {
      const file = `${page}-${vp}.png`;
      const ref = PNG.sync.read(fs.readFileSync(path.join(TEMPLATE, 'design/screenshots', file)));
      const got = PNG.sync.read(fs.readFileSync(path.join(dir, file)));
      scores[`${page}/${vp}`] = round(1 - compare(ref, got), 4);
    }
  }
  const mean = round(Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length, 4);
  console.log(`  visual similarity: mean ${mean}`);
  return { mean, scores };
}

// ----- Code stats -----

function codeStats() {
  const files = spawnSync('git', ['-c', 'safe.directory=*', 'ls-files', '--cached', '--others', '--exclude-standard', '.'], { cwd: appDir, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((f) => f && !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f))
    .filter((f) => fs.existsSync(path.join(appDir, f)));
  const SOURCE = /\.(m?[jt]sx?|vue|svelte|astro|html|css|scss|json)$/;
  let lines = 0;
  for (const f of files.filter((f) => SOURCE.test(f))) lines += fs.readFileSync(path.join(appDir, f), 'utf8').split('\n').length;
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const du = spawnSync('du', ['-sk', 'node_modules'], { cwd: appDir, encoding: 'utf8' }).stdout.split('\t')[0];
  // Versions actually installed for the measured build (not just the ranges in package.json).
  const installed = {};
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    try {
      installed[dep] = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', dep, 'package.json'), 'utf8')).version;
    } catch {
      installed[dep] = null;
    }
  }
  return {
    files: files.length,
    sourceLines: lines,
    dependencies: Object.keys(pkg.dependencies ?? {}).length,
    devDependencies: Object.keys(pkg.devDependencies ?? {}).length,
    nodeModulesKiB: Number(du) || null,
    installed,
  };
}

// ----- Main -----

const results = { appDir, measuredAt: new Date().toISOString(), runs: RUNS };
console.log(`Measuring ${appDir}`);
const stack = await startStack(appDir, { build: !args.includes('--skip-build') });
try {
  results.buildMs = stack.buildMs;
  // Warm up server-side caches: the measured visit is a new user on a site others already use.
  for (const urlPath of Object.values(LH_URLS)) {
    for (let i = 0; i < 2; i++) await fetch(`http://localhost:${APP_PORT}${urlPath}`).then((r) => r.arrayBuffer()).catch(() => {});
  }
  console.log('Lighthouse:');
  results.lighthouse = await runLighthouse();
  console.log('User flow:');
  results.flow = await runFlows();
  console.log('Visual:');
  results.visual = await runVisual();
  results.code = codeStats();
} finally {
  await stack.stop();
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Wrote ${path.join(out, 'results.json')}`);
