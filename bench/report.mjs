#!/usr/bin/env node
// Writes <runDir>/report.md and <runDir>/summary.json from the results of bench/run.mjs.
// Usage: node bench/report.mjs <runDir>
//
// Layout read: <runDir>/<framework>-<n>/{agent/run-info.txt, agent/transcript.jsonl,
// measure/results.json}. Each framework's numbers are medians across its iterations.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeTranscript } from './tokens.mjs';

export function readRunInfo(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d));

function readIteration(dir) {
  const info = readRunInfo(path.join(dir, 'agent/run-info.txt'));
  const it = { dir: path.basename(dir), info, agent: null, measure: null, errors: [] };
  try {
    it.agent = summarizeTranscript(path.join(dir, 'agent/transcript.jsonl'));
  } catch (err) {
    it.errors.push(`transcript: ${err.message}`);
  }
  const resultsFile = path.join(dir, 'measure/results.json');
  if (fs.existsSync(resultsFile)) it.measure = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  else it.errors.push(fs.existsSync(path.join(dir, 'measure/error.txt')) ? fs.readFileSync(path.join(dir, 'measure/error.txt'), 'utf8').trim().split('\n')[0] : 'not measured');
  return it;
}

function metrics(it) {
  const m = it.measure;
  const lh = (formFactor, key) =>
    m ? mean(Object.entries(m.lighthouse).filter(([k]) => k.endsWith(`/${formFactor}`)).map(([, v]) => v.median[key])) : null;
  return {
    testsPassed: it.info.final_test_exit === '0',
    tokens: it.agent?.tokens.total ?? null,
    outputTokens: it.agent?.tokens.output ?? null,
    cost: it.agent?.costUSD ?? null,
    wallMin: it.agent ? it.agent.wallMs / 60000 : null,
    turns: it.agent?.turns ?? null,
    mobilePerf: lh('mobile', 'performance'),
    mobileLcp: lh('mobile', 'lcp'),
    mobileFcp: lh('mobile', 'fcp'),
    mobileTbt: lh('mobile', 'tbt'),
    mobileCls: lh('mobile', 'cls'),
    jsKiB: m ? lh('mobile', 'scriptBytes') / 1024 : null,
    a11y: lh('mobile', 'accessibility'),
    desktopPerf: lh('desktop', 'performance'),
    desktopLcp: lh('desktop', 'lcp'),
    search: m?.flow.latency.search ?? null,
    open: m?.flow.latency.openPokemon ?? null,
    sort: m?.flow.latency.sortMoves ?? null,
    game: m?.flow.latency.changeGame ?? null,
    inp: m ? Math.max(...Object.values(m.flow.steps).map((s) => s.inp ?? 0)) : null,
    visual: m?.visual.mean ?? null,
    loc: m?.code.sourceLines ?? null,
    deps: m ? m.code.dependencies + m.code.devDependencies : null,
    buildS: m?.buildMs != null ? m.buildMs / 1000 : null,
  };
}

const COLUMNS = [
  ['Tests', (r) => `${r.passed}/${r.n}`],
  ['Tokens (M)', (r) => fmt(r.tokens / 1e6, 2)],
  ['Output tokens (k)', (r) => fmt(r.outputTokens / 1e3, 0)],
  ['Cost ($)', (r) => fmt(r.cost, 2)],
  ['Time (min)', (r) => fmt(r.wallMin, 1)],
  ['Turns', (r) => fmt(r.turns)],
  ['Mobile perf', (r) => fmt(r.mobilePerf * 100)],
  ['LCP (ms)', (r) => fmt(r.mobileLcp)],
  ['FCP (ms)', (r) => fmt(r.mobileFcp)],
  ['TBT (ms)', (r) => fmt(r.mobileTbt)],
  ['CLS', (r) => fmt(r.mobileCls, 3)],
  ['JS (KiB)', (r) => fmt(r.jsKiB)],
  ['Desktop perf', (r) => fmt(r.desktopPerf * 100)],
  ['A11y', (r) => fmt(r.a11y * 100)],
  ['Search (ms)', (r) => fmt(r.search)],
  ['Open Pokémon (ms)', (r) => fmt(r.open)],
  ['Sort (ms)', (r) => fmt(r.sort)],
  ['Change game (ms)', (r) => fmt(r.game)],
  ['Max INP (ms)', (r) => fmt(r.inp)],
  ['Visual match', (r) => fmt(r.visual, 3)],
  ['LOC', (r) => fmt(r.loc)],
  ['Deps', (r) => fmt(r.deps)],
  ['Build (s)', (r) => fmt(r.buildS, 1)],
];

export function writeReport(runDir) {
  const config = fs.existsSync(path.join(runDir, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'config.json'), 'utf8')) : {};
  const iterations = fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-\d+$/.test(d.name))
    .map((d) => readIteration(path.join(runDir, d.name)));

  const byFramework = new Map();
  for (const it of iterations) {
    const fw = it.info.framework ?? it.dir.replace(/-\d+$/, '');
    if (!byFramework.has(fw)) byFramework.set(fw, []);
    byFramework.get(fw).push(it);
  }

  const rows = [...byFramework].map(([fw, its]) => {
    const ms = its.map(metrics);
    const row = { framework: fw, n: its.length, passed: ms.filter((m) => m.testsPassed).length };
    for (const key of Object.keys(ms[0])) if (key !== 'testsPassed') row[key] = median(ms.map((m) => m[key]));
    return row;
  });
  rows.sort((a, b) => (a.tokens ?? Infinity) - (b.tokens ?? Infinity));

  const table = (cols) =>
    [
      `| Framework | ${cols.map(([h]) => h).join(' | ')} |`,
      `| --- | ${cols.map(() => '---:').join(' | ')} |`,
      ...rows.map((r) => `| ${r.framework} | ${cols.map(([, f]) => f(r)).join(' | ')} |`),
    ].join('\n');

  const versions = iterations
    .map((it) => `| ${it.dir} | ${it.info.claude_code ?? '—'} | ${it.info.model ?? '—'} | ${it.info.final_test_exit === '0' ? 'pass' : 'FAIL'} | ${it.errors.join('; ') || '—'} |`)
    .join('\n');

  const md = `# Pokédex framework benchmark

Run \`${path.basename(runDir)}\`, started ${config.startedAt ?? '—'}.
${config.iterations ?? '?'} iteration(s) per framework; numbers are medians across iterations.
Lighthouse values are means over ${Object.keys(iterations[0]?.measure?.lighthouse ?? {}).length / 2 || 6} URLs, each the median of ${config.lighthouseRuns ?? '?'} runs.
Sorted by total tokens.

## Building the app (agent)

${table(COLUMNS.slice(0, 6))}

## Page loads (Lighthouse, mobile preset unless noted)

${table(COLUMNS.slice(6, 14))}

## Interactions (scripted flow, DevTools throttling)

Time from the user's action until the result is on screen.

${table(COLUMNS.slice(14, 19))}

## Codebase and fidelity

"Visual match" is the share of pixels that match the reference screenshots (1 = identical).

${table(COLUMNS.slice(19))}

## Iterations

| Iteration | Claude Code | Model | Final tests | Problems |
| --- | --- | --- | --- | --- |
${versions}
`;
  fs.writeFileSync(path.join(runDir, 'report.md'), md);
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ config, rows }, null, 2));
  return md;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('Usage: report.mjs <runDir>');
    process.exit(1);
  }
  console.log(writeReport(path.resolve(runDir)));
}
