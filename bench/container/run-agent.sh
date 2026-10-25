#!/usr/bin/env bash
# Container entrypoint: runs one agent on the spec and saves its repo. Everything lands in
# /out. Started by bench/run.mjs, which then runs the tests in a separate container.
#
# Env (set by run.mjs):
#   FRAMEWORK   framework key (see bench/frameworks.mjs)
#   PROMPT      the prompt given to Claude Code
#   MODEL       optional model override
#   ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
set -euo pipefail

: "${FRAMEWORK:?FRAMEWORK is required}"
: "${PROMPT:?PROMPT is required}"
OUT=/out
WORK=/home/agent/work
mkdir -p "$OUT"

/home/agent/setup-tooling.sh "$FRAMEWORK" /home/agent/mcp.json "$OUT/tooling-versions.json" > "$OUT/tooling.log" 2>&1

{
  echo "framework=$FRAMEWORK"
  echo "prompt=$PROMPT"
  echo "model=${MODEL:-default}"
  echo "claude_code=$(claude --version)"
  echo "agent_browser=$(agent-browser --version 2>/dev/null || true)"
  echo "node=$(node --version)"
  echo "npm=$(npm --version)"
  echo "playwright=$(npx playwright --version | sed 's/^Version //')"
  echo "started=$(date -u +%FT%TZ)"
} > "$OUT/run-info.txt"

cd "$WORK"
MODEL_ARGS=()
if [ -n "${MODEL:-}" ]; then MODEL_ARGS=(--model "$MODEL"); fi
# --strict-mcp-config ignores every MCP server not in mcp.json, including ones that come
# from plugins, so it's left off for frameworks whose tooling is a plugin.
STRICT_MCP=(--strict-mcp-config)
if [ "$FRAMEWORK" = sveltekit ]; then STRICT_MCP=(); fi
set +e
claude -p "$PROMPT" \
  "${MODEL_ARGS[@]}" \
  --mcp-config /home/agent/mcp.json "${STRICT_MCP[@]}" \
  --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  > "$OUT/transcript.jsonl" 2> "$OUT/claude-stderr.log"
echo "claude_exit=$?" >> "$OUT/run-info.txt"
# The MCP servers the session actually had, from its init event, as name:status pairs.
echo "mcp_servers=$(jq -rR 'fromjson? | select(.type == "system" and .subtype == "init") | [.mcp_servers[]? | "\(.name):\(.status)"] | join(",")' "$OUT/transcript.jsonl" 2>/dev/null | head -n 1)" >> "$OUT/run-info.txt"
set -e
echo "finished=$(date -u +%FT%TZ)" >> "$OUT/run-info.txt"

# Keep the agent's repo (without dependencies or data) for testing and measurement.
git -C "$WORK" status --short > "$OUT/git-status.txt" || true
tar --exclude=node_modules --exclude=./data --exclude=./.data-cache --exclude=./test-results \
  -czf "$OUT/repo.tar.gz" -C "$WORK" .
echo "Done. Results in $OUT"
