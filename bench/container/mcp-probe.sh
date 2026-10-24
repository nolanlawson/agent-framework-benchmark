#!/usr/bin/env bash
# Prints {serverInfo, tools, toolsSha256} for a Streamable HTTP MCP server, so runs record
# what a hosted MCP server offered at the time (hosted servers cannot be pinned).
# Usage: mcp-probe.sh <url>
set -euo pipefail
URL="$1"; H=$(mktemp)
post() { curl -s --max-time 30 -X POST "$URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "$@"; }
json() { sed -n 's/^data: //p; t; /^{/p'; }
INIT=$(post -D "$H" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"pokedex-bench","version":"1"}}}' | json)
SID=$(grep -i '^mcp-session-id:' "$H" | cut -d' ' -f2 | tr -d '\r' || true)
SESSION=(); [ -n "$SID" ] && SESSION=(-H "Mcp-Session-Id: $SID")
post "${SESSION[@]}" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
TOOLS=$(post "${SESSION[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | json)
rm -f "$H"
jq -n --argjson init "$INIT" --argjson tools "$TOOLS" \
  '{serverInfo: $init.result.serverInfo | {name, version}, tools: [$tools.result.tools[].name], toolsSha256: ($tools.result.tools | tojson)}' \
  | jq --arg sha "$(jq -cS '.result.tools' <<<"$TOOLS" | sha256sum | cut -d' ' -f1)" '.toolsSha256 = $sha'
