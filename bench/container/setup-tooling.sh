#!/usr/bin/env bash
# Installs the AI tooling each framework's official docs recommend for coding agents
# (checked 2026-10-24), writes the MCP config passed to Claude Code, and records the exact
# version of everything it set up. npx-launched MCP servers are pinned to the version
# recorded here, so what's recorded is what runs.
#
# Usage: setup-tooling.sh <framework> <mcp-config-out> <versions-out>
set -euo pipefail

FRAMEWORK="$1"
MCP_OUT="$2"
VERSIONS_OUT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
RECORDS="$(mktemp)"
cd "${WORK:-/home/agent/work}"

record() { # record <json object>
  jq -e . <<<"$1" > /dev/null || { echo "Bad version record: $1" >&2; exit 1; }
  printf '%s\n' "$1" >> "$RECORDS"
}
npm_version() { # latest published version of an npm package
  npm view "$1" version
}
git_head() { # current commit of a GitHub repo's default branch
  git ls-remote "https://github.com/$1.git" HEAD | cut -f1
}
mcp() { # writes the MCP config: mcp '<json for mcpServers>'
  printf '{ "mcpServers": %s }\n' "$1" > "$MCP_OUT"
}
stdio_mcp() { # stdio_mcp <server name> <npm package> [args...]: run via npx, pinned
  local name="$1" pkg="$2" version
  shift 2
  version="$(npm_version "$pkg")"
  record "$(jq -nc --arg n "$name" --arg p "$pkg" --arg v "$version" '{kind: "mcp (stdio)", name: $n, package: $p, version: $v}')"
  jq -nc --arg n "$name" --arg spec "$pkg@$version" --args '{($n): {type: "stdio", command: "npx", args: (["-y", $spec] + $ARGS.positional)}}' "$@"
}
http_mcp() { # http_mcp <server name> <url>: hosted, can't be pinned, so record what it offers
  local name="$1" url="$2" probe
  probe="$("$HERE/mcp-probe.sh" "$url" 2>/dev/null || echo '{"error": "probe failed"}')"
  record "$(jq -nc --arg n "$name" --arg u "$url" --argjson p "$probe" '{kind: "mcp (hosted)", name: $n, url: $u} + $p')"
  jq -nc --arg n "$name" --arg u "$url" '{($n): {type: "http", url: $u}}'
}
skill() { # skill <github owner/repo> [skills add args...]: installs into .claude/skills
  local repo="$1" cli commit args entry
  shift
  cli="$(npm_version skills)"
  commit="$(git_head "$repo")"
  args="$(printf '%s\n' "$@" | jq -R . | jq -sc 'map(select(length > 0))')"
  entry="$(jq -nc --arg r "$repo" --arg c "$commit" --arg cli "$cli" --argjson a "$args" '{kind: "skill", repo: $r, commit: $c, args: $a, skillsCli: $cli}')"
  record "$entry"
  npx -y "skills@$cli" add "https://github.com/$repo" "$@" -a claude-code -y --copy
}

mcp '{}'
case "$FRAMEWORK" in
  next)
    # https://nextjs.org/docs/app/guides/ai-agents (AGENTS.md is created by create-next-app)
    servers="$(stdio_mcp next-devtools next-devtools-mcp)"
    mcp "$servers"
    skill vercel/next.js --skill next-dev-loop
    ;;
  nuxt)
    # https://nuxt.com/docs/4.x/guide/ai
    servers="$(http_mcp nuxt https://nuxt.com/mcp)"
    mcp "$servers"
    ;;
  astro)
    # https://docs.astro.build/en/guides/build-with-ai/
    servers="$(http_mcp astro-docs https://mcp.docs.astro.build/mcp)"
    mcp "$servers"
    ;;
  sveltekit)
    # https://svelte.dev/docs/ai/claude-plugin (plugin = local MCP server + skills + subagent).
    # The plugin starts @sveltejs/mcp through npx itself; its version is recorded as resolved now.
    record "$(jq -nc --arg c "$(git_head sveltejs/ai-tools)" --arg mcp "$(npm_version @sveltejs/mcp)" \
      '{kind: "claude plugin", name: "svelte@svelte", repo: "sveltejs/ai-tools", commit: $c, mcpPackage: "@sveltejs/mcp", mcpVersion: $mcp}')"
    claude plugin marketplace add sveltejs/ai-tools
    claude plugin install svelte@svelte
    ;;
  angular)
    # https://angular.dev/ai/mcp and https://angular.dev/ai/agent-skills
    servers="$(stdio_mcp angular-cli @angular/cli mcp)"
    mcp "$servers"
    skill angular/skills
    ;;
  hono-htmx)
    # https://hono.dev/docs/agents (no official htmx tooling)
    skill honojs/skills
    ;;
  react-router)
    # The skill create-react-router copies into new apps (.agents/skills/react-router), installed
    # up front because agents don't always use create-react-router. Docs ship in node_modules.
    skill remix-run/react-router --skill react-router
    ;;
  tanstack-start | solidstart | qwik | gracile | vanilla)
    # No official agent tooling (TanStack removed its MCP server in favour of its CLI).
    ;;
  *)
    echo "Unknown framework: $FRAMEWORK" >&2
    exit 1
    ;;
esac

jq -s '.' "$RECORDS" > "$VERSIONS_OUT"
rm -f "$RECORDS"
echo "Tooling for $FRAMEWORK:"
cat "$MCP_OUT" "$VERSIONS_OUT"
ls .claude/skills 2>/dev/null || true
