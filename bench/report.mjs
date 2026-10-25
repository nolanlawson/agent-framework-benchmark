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
// Missing values print as a dash. Scale before formatting, never before the null check
// (null * 100 is 0 in JS).
const fmt = (x, d = 0, scale = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : (x * scale).toFixed(d));

function readIteration(dir) {
  const info = readRunInfo(path.join(dir, 'agent/run-info.txt'));
  const it = { dir: path.basename(dir), info, agent: null, measure: null, tooling: [], errors: [] };
  try {
    it.tooling = JSON.parse(fs.readFileSync(path.join(dir, 'agent/tooling-versions.json'), 'utf8'));
  } catch {}
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
    cacheReadTokens: it.agent?.tokens.cacheRead ?? null,
    // Input the model processed fresh: plain input plus cache writes.
    uncachedInputTokens: it.agent ? it.agent.tokens.input + it.agent.tokens.cacheWrite : null,
    outputTokens: it.agent?.tokens.output ?? null,
    cost: it.agent?.costUSD ?? null,
    wallMin: it.agent ? it.agent.wallMs / 60000 : null,
    turns: it.agent?.turns ?? null,
    mobilePerf: lh('mobile', 'performance'),
    mobileLcp: lh('mobile', 'lcp'),
    mobileFcp: lh('mobile', 'fcp'),
    mobileTbt: lh('mobile', 'tbt'),
    mobileCls: lh('mobile', 'cls'),
    jsKiB: lh('mobile', 'scriptBytes'),
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
  ['Total tokens (M)', (r) => fmt(r.tokens, 2, 1e-6)],
  ['Cache read (M)', (r) => fmt(r.cacheReadTokens, 2, 1e-6)],
  ['Uncached input (k)', (r) => fmt(r.uncachedInputTokens, 0, 1e-3)],
  ['Output (k)', (r) => fmt(r.outputTokens, 0, 1e-3)],
  ['Cost ($)', (r) => fmt(r.cost, 2)],
  ['Time (min)', (r) => fmt(r.wallMin, 1)],
  ['Turns', (r) => fmt(r.turns)],
  ['Mobile perf', (r) => fmt(r.mobilePerf, 0, 100)],
  ['LCP (ms)', (r) => fmt(r.mobileLcp)],
  ['FCP (ms)', (r) => fmt(r.mobileFcp)],
  ['TBT (ms)', (r) => fmt(r.mobileTbt)],
  ['CLS', (r) => fmt(r.mobileCls, 3)],
  ['JS (KiB)', (r) => fmt(r.jsKiB, 0, 1 / 1024)],
  ['Desktop perf', (r) => fmt(r.desktopPerf, 0, 100)],
  ['A11y', (r) => fmt(r.a11y, 0, 100)],
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

function toolingLabel(t) {
  if (t.kind === 'skill') return `skill ${t.repo}@${t.commit?.slice(0, 7)}${t.args?.length ? ` (${t.args.join(' ')})` : ''}`;
  if (t.kind === 'mcp (stdio)') return `MCP ${t.package}@${t.version}`;
  if (t.kind === 'mcp (hosted)') return `MCP ${t.url} (${t.tools?.length ?? '?'} tools, sha256 ${t.toolsSha256?.slice(0, 12) ?? '?'})`;
  if (t.kind === 'claude plugin') return `plugin ${t.name}@${t.commit?.slice(0, 7)} (${t.mcpPackage}@${t.mcpVersion})`;
  return JSON.stringify(t);
}

function versionsSection(iterations) {
  return iterations
    .map((it) => {
      const deps = Object.entries(it.measure?.code.installed ?? {})
        .map(([name, version]) => `\`${name}@${version ?? '?'}\``)
        .join(', ');
      const tooling = it.tooling.map(toolingLabel).join('; ') || 'none';
      return `- **${it.dir}**: ${deps || 'not measured'}\n  - Tooling: ${tooling}\n  - MCP servers in the session: ${it.info.mcp_servers || 'none'}\n  - Node ${it.info.node ?? '?'}, npm ${it.info.npm ?? '?'}, Claude Code ${it.info.claude_code ?? '?'}, agent-browser ${it.info.agent_browser ?? '?'}`;
    })
    .join('\n');
}

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
    .map((it) => `| ${it.dir} | ${it.info.claude_code ?? '—'} | ${it.info.model ?? '—'}${it.info.effort ? ` (${it.info.effort})` : ''} | ${it.info.node ?? '—'} | ${it.info.final_test_exit === '0' ? 'pass' : 'FAIL'} | ${it.errors.join('; ') || '—'} |`)
    .join('\n');

  const md = `# Pokédex framework benchmark

Run \`${path.basename(runDir)}\`, started ${config.startedAt ?? '—'}.
${config.iterations ?? '?'} iteration(s) per framework; numbers are medians across iterations.
Lighthouse values are means over ${Object.keys(iterations[0]?.measure?.lighthouse ?? {}).length / 2 || 6} URLs, each the median of ${config.lighthouseRuns ?? '?'} runs.
Sorted by total tokens.

## Building the app (agent)

Total tokens = cache reads + uncached input (input and cache writes) + output.

${table(COLUMNS.slice(0, 8))}

## Page loads (Lighthouse, mobile preset unless noted)

${table(COLUMNS.slice(8, 16))}

## Interactions (scripted flow, DevTools throttling)

Time from the user's action until the result is on screen (for search, from the last keystroke).

${table(COLUMNS.slice(16, 21))}

## Codebase and fidelity

"Visual match" is the share of pixels that match the reference screenshots (1 = identical).

${table(COLUMNS.slice(21))}

## Versions

Direct dependencies of each app, as installed for measurement, and the agent tooling.

${versionsSection(iterations)}

## Iterations

| Iteration | Claude Code | Model | Node | Final tests | Problems |
| --- | --- | --- | --- | --- | --- |
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
