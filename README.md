# Pokédex framework benchmark

How many tokens, and how much time, does a coding agent need to build the same
non-trivial web app in different frameworks? And how fast is the app it builds?

Each agent gets the same spec (a Pokédex backed by a local copy of PokeAPI), the same
tests, the same tools and the same one-line prompt. The only difference is the framework
it's told to use. Each agent runs alone in a fresh Podman container. Afterwards, the
app it built is measured in another container with Lighthouse, a scripted user flow and a
screenshot comparison.

## Quick start

Requirements: Linux, Podman 4.3 or later (rootless recommended), Node 20 or later, about
15 GB of disk, and Claude credentials.

```sh
nvm install && nvm use               # the Node version in .nvmrc

# Claude credentials: an API key, or a long-lived token from `claude setup-token`
export CLAUDE_CODE_OAUTH_TOKEN=...      # or ANTHROPIC_API_KEY=...

# One agent, one framework
node bench/run.mjs --frameworks=vanilla --iterations=1

# Everything
node bench/run.mjs --frameworks=all --iterations=3
```

The run creates `runs/<timestamp>/`, and the results end up in `runs/<timestamp>/report.md`.

The Pokémon data (about 2 GB, from pinned commits of PokeAPI's repos) is downloaded **once**,
when the `pokedex-base` image is first built. It sits in an image layer that later builds
reuse, so no agent ever downloads it and it costs no tokens. Only `--no-cache`, or a
change to `template/scripts/`, downloads it again.

Read `bench/run.mjs` before you run it: it's the only thing that runs on your machine.
Agents, and the apps they write, only ever run inside containers.

### Options

| Option | Default | |
| --- | --- | --- |
| `--frameworks=a,b` or `all` | (required) | Keys from `bench/frameworks.mjs`: `next`, `nuxt`, `tanstack-start`, `react-router`, `solidstart`, `sveltekit`, `angular`, `astro`, `qwik`, `gracile`, `hono-htmx`, `vanilla` |
| `--iterations=N` | 1 | Agent runs per framework |
| `--model=ID` | `claude-opus-5-5` | Passed to `claude --model` |
| `--effort=LEVEL` | `medium` | Passed to `claude --effort` (`low`, `medium`, `high`, `xhigh`, `max`) |
| `--claude-version=V` | `2.1.310` | Claude Code version installed in the agent image |
| `--cpus=N`, `--memory=SIZE` | 4, `8g` | Limits for every container, agent and measurement alike |
| `--agent-timeout=MIN` | 240 | Stops an agent that runs longer than this |
| `--lighthouse-runs=N` | 5 | Lighthouse runs per URL and form factor; the median is kept |
| `--no-cache` | | Rebuild the images from scratch, pulling a fresh Ubuntu image |
| `--skip-image-build` | | Reuse the existing images |
| `--no-measure` | | Stop after the agents finish |
| `--measure-failed` | | Also measure apps that failed the final tests. By default they're skipped, so broken apps don't get performance numbers |
| `--measure-only=runs/<id>` | | Measure an earlier run again and rewrite its report. Rebuilds only the base and measure images, and records them as `measureOnlyImages` in `config.json` |
| `--report-only=runs/<id>` | | Only rewrite `report.md` |
| `--out=DIR` | `runs` | Where run directories go |

### Credentials

`run.mjs` looks for `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN` (create one with
`claude setup-token`). Whichever it finds is passed to each agent container as an environment
variable. It never goes on a command line or into the run directory.

Your normal login in `~/.claude/.credentials.json` isn't used: its refresh token is replaced
whenever it's used, so a copy handed to one container would stop working for the next one,
and for you.

The agent, and anything it runs (npm install scripts, MCP servers), can read the
credential. Use a key with a spending limit.

## What happens in a run

1. **Images.** `bench/container/export-template.sh` copies `template/` into a fresh git repo
   with a single commit, so agents can't see this repo's history, the gold-standard app or the
   measurement code. Then three images are built:
   - **`pokedex-base`**: Ubuntu 24.04, Node 24, Playwright's Chromium, and the exported repo.
     The Pokémon data is downloaded here, once, by `template/scripts/setup-data.sh`. It
     fetches pinned commits of PokeAPI's `api-data`, `sprites` (a subset) and `cries`, and
     rewrites media URLs to point at the local API server.
   - **`pokedex-agent`**: adds Claude Code and `agent-browser`, and sets `IS_SANDBOX=1`.
   - **`pokedex-measure`**: adds Caddy and the measurement scripts.
2. **Agents.** For each framework and iteration, one at a time, `run-agent.sh` runs in a new
   agent container:
   - It installs the framework's official AI tooling (see below).
   - It runs `claude -p "<prompt>" --dangerously-skip-permissions --output-format stream-json`,
     with no other MCP servers.
   - When the agent stops, it saves the agent's repo.
   - Then the agent's `app/`, and only that, is copied into a fresh `pokedex-base` container,
     where `npm test` runs. Whatever else the agent changed (tests, data, `node_modules`) or
     left running can't affect the result.
   - `pokeapi.co` resolves to localhost, so the app can only use the local API.
3. **Measurement.** Each app is built and served in production mode behind Caddy (HTTPS,
   HTTP/2, zstd/gzip), with the API behind Caddy too. Then:
   - **Lighthouse**, mobile settings only, on 6 URLs: the median of N runs. Server-side
     caches are warmed first, so each visit is a new user on a site other people already use.
   - **A scripted user flow** under DevTools throttling: type in search, open a Pokémon, sort
     the moves table, change the game. It records the time from each action until the result is
     on screen (for search, from the last keystroke), plus INP and TBT.
   - Apps that failed the final tests are skipped unless you pass `--measure-failed`.
   - **Visual match**: the share of pixels that agree with the reference screenshots.
   - **Code stats**: lines of code, dependency count, build time.
4. **Report.** `bench/report.mjs` writes `report.md` and `summary.json`. With several
   iterations, each framework's numbers are medians across them.

### The prompt

The same for every agent, apart from the framework label in `bench/frameworks.mjs`:

> Implement the app described in SPEC.md using **{framework}**. Use the latest stable
> version. Work autonomously until `npm test` passes.

### Per-framework AI tooling

Each agent gets what that framework's official docs recommend for coding agents (checked
October 2026), installed by `bench/container/setup-tooling.sh`. Frameworks with no official
tooling get nothing extra. Uneven tooling is part of what's being measured: it's what you
get when you pick that framework.

| Framework | Tooling |
| --- | --- |
| Next.js | `next-devtools-mcp`, `next-dev-loop` skill; `create-next-app` writes `AGENTS.md` and docs ship in `node_modules` |
| Nuxt | Nuxt MCP server (`https://nuxt.com/mcp`) |
| Astro | Astro Docs MCP server (`https://mcp.docs.astro.build/mcp`) |
| SvelteKit | Svelte Claude Code plugin: MCP server, skills, subagent |
| Angular | Angular CLI MCP server (`ng mcp`), Angular agent skills |
| React Router | React Router skill (the one `create-react-router` adds to new apps); docs ship in `node_modules` |
| Hono + htmx | Hono skills (nothing official for htmx) |
| TanStack Start, SolidStart, Qwik, Gracile + Lit, vanilla | None |

## Reading a run

For each iteration, `runs/<id>/<framework>-<n>/` contains:

| Path | What it is |
| --- | --- |
| `agent/transcript.jsonl` | The agent's full session (Claude Code stream-json) |
| `agent/run-info.txt` | Versions, start and finish times, the MCP servers the session had (`mcp_servers`), and the exit codes of `claude` and the final `npm test` |
| `agent/final-test.log` | The final test run: the original tests, in a fresh container with only the agent's `app/` |
| `agent/tooling.log` | Output of `setup-tooling.sh` |
| `agent/tooling-versions.json` | Exact versions or commits of the MCP servers, skills and plugins the agent had |
| `agent/git-status.txt` | Files the agent changed or added |
| `container.log` | Podman output for the agent container |
| `repo/` | The agent's repo; the app is in `repo/app/` |
| `measure/results.json` | Every measurement, including raw runs |
| `measure/lighthouse/` | Lighthouse reports (first run of each URL) and the flow report |
| `measure/screenshots/` | Screenshots to compare with `template/design/screenshots/` |
| `measure/error.txt` | Why measurement failed, if it did |

To summarize a single transcript: `node bench/tokens.mjs runs/<id>/<framework>-<n>/agent/transcript.jsonl`.

## Repository layout

| Path | |
| --- | --- |
| `template/` | Everything an agent sees: `SPEC.md`, `api/server.mjs` (local PokeAPI), `scripts/setup-data.sh`, `tests/`, `design/` |
| `template/tests/` | Playwright acceptance tests that query roles, accessible names and text, not DOM structure. `run.mjs` builds the app against the normal API, then runs it against an API with changed data (`fixtures/live-data-overlay.json`) to catch apps that bake data in at build time |
| `gold/` | Dependency-free reference implementation. It produced `template/design/screenshots/` and is used to check the tests (`APP_DIR=../gold npm test` in `template/`). Agents never see it |
| `bench/run.mjs` | The orchestrator |
| `bench/container/` | Containerfiles, the export script, the agent entrypoint and the tooling setup |
| `bench/measure.mjs`, `stack.mjs`, `screenshots.mjs` | Measurement (run inside `pokedex-measure`) |
| `bench/report.mjs`, `tokens.mjs` | Report generation |
| `docs/audits/` | Periodic code audits: findings, and what was decided on each and why. One file per audit, named by date |

### Working on the harness without Podman

```sh
cd template && ./scripts/setup-data.sh && npm install && npx playwright install chromium
npm run api                          # local PokeAPI on :9000
(cd ../gold && npm start)            # gold app on :3000
APP_DIR=../gold npm test             # all tests should pass
cd ../bench && npm install
node measure.mjs ../gold /tmp/gold-results --runs 1 --skip-build   # needs Caddy installed
```

## Design decisions and known limitations

- **The data is live.** Apps must fetch from the API at request time; build-time fetching and
  static generation of data pages aren't allowed, and the tests check this. Otherwise one
  architecture (prerender everything) would win by sidestepping the API.
- **No artificial latency** on the API. The browser's API requests are slowed by Lighthouse's
  throttling, but an MPA server's calls to the API run at localhost speed, like an app server
  sitting next to its API. Keep this in mind when comparing SPAs with MPAs.
- **The site is content-heavy**, which favors server-rendered MPAs on first-load metrics.
  The interaction flow (search, sorting, client navigation) is where SPAs can win back ground.
- **Styling is constrained**: shared design tokens, system fonts, no CSS frameworks or
  component libraries, no animations. This keeps visual and CSS differences from dominating
  the results.
- **"Change game" has no INP.** A native `<select>` can't be operated by a real interaction
  in headless Chrome, so the flow sets the value and dispatches the events itself. Its
  latency is still measured.
- **Pinned versus recorded.** Node is pinned by `.nvmrc` (a symlink to `template/.nvmrc`);
  the containers install that exact version from nodejs.org, with checksum verification,
  and npm is the version bundled with it. Playwright and agent-browser are pinned in the
  Containerfiles; Claude Code, the model and the effort level by `run.mjs`'s defaults. Frameworks and
  their AI tooling are deliberately *not* pinned: each agent uses the latest release, like a
  real user would. Each result is a dated snapshot of the whole ecosystem (model, frameworks,
  tooling, docs, search results), none of which can be frozen for a rerun years later anyway.
  Everything that was used is recorded instead:
  - the app's installed dependency versions (`measure/results.json`, and the report)
  - MCP package versions; npx-launched servers are pinned to exactly the recorded version
  - for hosted MCP servers, their tool list and a hash of it
  - the commit of every skill and plugin repo (`agent/tooling-versions.json`)
  - Node, npm, Playwright, Claude Code and agent-browser versions (`agent/run-info.txt`)
  - the image IDs and the Ubuntu base image digest (`config.json`)
- **One iteration is an anecdote.** Agent runs vary a lot; use 3 or more iterations before
  drawing conclusions.
