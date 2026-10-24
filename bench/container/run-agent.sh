#!/usr/bin/env bash
# Container entrypoint: runs one agent on the spec, then checks its work with the
# pristine tests. Everything lands in /out. Started by bench/run.mjs.
#
# Env (set by run.mjs):
#   FRAMEWORK   framework key (see bench/frameworks.mjs)
#   PROMPT      the prompt given to Claude Code
#   MODEL       optional model override
#   ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or HOST_CLAUDE_CREDENTIALS (the contents
#   of the host's ~/.claude/.credentials.json)
set -euo pipefail

: "${FRAMEWORK:?FRAMEWORK is required}"
: "${PROMPT:?PROMPT is required}"
OUT=/out
WORK=/home/agent/work
mkdir -p "$OUT"

if [ -n "${HOST_CLAUDE_CREDENTIALS:-}" ]; then
  mkdir -p ~/.claude
  (umask 077 && printf '%s' "$HOST_CLAUDE_CREDENTIALS" > ~/.claude/.credentials.json)
  unset HOST_CLAUDE_CREDENTIALS
fi

/home/agent/setup-tooling.sh "$FRAMEWORK" /home/agent/mcp.json > "$OUT/tooling.log" 2>&1

{
  echo "framework=$FRAMEWORK"
  echo "prompt=$PROMPT"
  echo "model=${MODEL:-default}"
  echo "claude_code=$(claude --version)"
  echo "agent_browser=$(agent-browser --version 2>/dev/null || true)"
  echo "node=$(node --version)"
  echo "started=$(date -u +%FT%TZ)"
} > "$OUT/run-info.txt"

cd "$WORK"
MODEL_ARGS=()
if [ -n "${MODEL:-}" ]; then MODEL_ARGS=(--model "$MODEL"); fi
set +e
claude -p "$PROMPT" \
  "${MODEL_ARGS[@]}" \
  --mcp-config /home/agent/mcp.json --strict-mcp-config \
  --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  > "$OUT/transcript.jsonl" 2> "$OUT/claude-stderr.log"
echo "claude_exit=$?" >> "$OUT/run-info.txt"
set -e
echo "finished=$(date -u +%FT%TZ)" >> "$OUT/run-info.txt"

# Final check: restore everything the agent must not change, then run the tests.
cp -r /home/agent/pristine/. "$WORK/"
set +e
npm test > "$OUT/final-test.log" 2>&1
echo "final_test_exit=$?" >> "$OUT/run-info.txt"
set -e

# Keep the agent's repo (without dependencies or data) for measurement on the host.
git -C "$WORK" status --short > "$OUT/git-status.txt" || true
tar --exclude=node_modules --exclude=./data --exclude=./.data-cache --exclude=./test-results \
  -czf "$OUT/repo.tar.gz" -C "$WORK" .
echo "Done. Results in $OUT"
