#!/usr/bin/env bash
# Installs the AI tooling each framework's official docs recommend for coding agents
# (checked 2026-10-24), and writes the MCP config passed to Claude Code.
#
# Usage: setup-tooling.sh <framework> <mcp-config-out>
set -euo pipefail

FRAMEWORK="$1"
MCP_OUT="$2"
cd /home/agent/work

mcp() { # writes the MCP config: mcp '<json for mcpServers>'
  printf '{ "mcpServers": %s }\n' "$1" > "$MCP_OUT"
}
skill() { # installs an agent skill into the project (.claude/skills)
  npx -y skills@latest add "$@" -a claude-code -y --copy
}

mcp '{}'
case "$FRAMEWORK" in
  next)
    # https://nextjs.org/docs/app/guides/ai-agents (AGENTS.md is created by create-next-app)
    mcp '{ "next-devtools": { "type": "stdio", "command": "npx", "args": ["-y", "next-devtools-mcp@latest"] } }'
    skill vercel/next.js --skill next-dev-loop
    ;;
  nuxt)
    # https://nuxt.com/docs/4.x/guide/ai
    mcp '{ "nuxt": { "type": "http", "url": "https://nuxt.com/mcp" } }'
    ;;
  astro)
    # https://docs.astro.build/en/guides/build-with-ai/
    mcp '{ "astro-docs": { "type": "http", "url": "https://mcp.docs.astro.build/mcp" } }'
    ;;
  sveltekit)
    # https://svelte.dev/docs/ai/claude-plugin (plugin = local MCP server + skills + subagent)
    claude plugin marketplace add sveltejs/ai-tools
    claude plugin install svelte@ai-tools
    ;;
  angular)
    # https://angular.dev/ai/mcp and https://angular.dev/ai/agent-skills
    mcp '{ "angular-cli": { "type": "stdio", "command": "npx", "args": ["-y", "@angular/cli", "mcp"] } }'
    skill https://github.com/angular/skills
    ;;
  hono-htmx)
    # https://hono.dev/docs/agents (no official htmx tooling)
    skill honojs/skills
    ;;
  react-router)
    # create-react-router adds the official skill itself in non-interactive runs; docs ship
    # in node_modules/react-router/docs. Nothing to configure up front.
    ;;
  tanstack-start | solidstart | qwik | gracile | vanilla)
    # No official agent tooling (TanStack removed its MCP server in favour of its CLI).
    ;;
  *)
    echo "Unknown framework: $FRAMEWORK" >&2
    exit 1
    ;;
esac
echo "Tooling for $FRAMEWORK:"
cat "$MCP_OUT"
ls .claude/skills 2>/dev/null || true
