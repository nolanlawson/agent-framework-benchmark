#!/usr/bin/env node
// Summarizes a Claude Code stream-json transcript: node bench/tokens.mjs <transcript.jsonl>
// Prints JSON with wall time, turns, cost and token counts (all models, including subagents).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function summarizeTranscript(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const events = lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const result = events.findLast((e) => e.type === 'result');
  if (!result) throw new Error(`No result event in ${file}; the run may not have finished`);

  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
  const models = result.modelUsage ?? {};
  for (const usage of Object.values(models)) for (const k of Object.keys(totals)) totals[k] += usage[k] ?? 0;
  if (!Object.keys(models).length && result.usage) {
    totals.inputTokens = result.usage.input_tokens ?? 0;
    totals.outputTokens = result.usage.output_tokens ?? 0;
    totals.cacheReadInputTokens = result.usage.cache_read_input_tokens ?? 0;
    totals.cacheCreationInputTokens = result.usage.cache_creation_input_tokens ?? 0;
  }
  const toolCalls = {};
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    for (const block of e.message?.content ?? []) {
      if (block.type === 'tool_use') toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
    }
  }
  return {
    outcome: result.subtype,
    isError: result.is_error ?? false,
    wallMs: result.duration_ms,
    apiMs: result.duration_api_ms,
    turns: result.num_turns,
    costUSD: result.total_cost_usd ?? totals.costUSD,
    tokens: {
      input: totals.inputTokens,
      output: totals.outputTokens,
      cacheRead: totals.cacheReadInputTokens,
      cacheWrite: totals.cacheCreationInputTokens,
      total: totals.inputTokens + totals.outputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens,
    },
    models: Object.fromEntries(Object.entries(models).map(([m, u]) => [m, u])),
    toolCalls,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(summarizeTranscript(process.argv[2]), null, 2));
}
