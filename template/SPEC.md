# Pokédex app specification

Build a Pokédex web app: a browsable encyclopedia of Pokémon, moves, abilities and
types, backed by the local PokeAPI server in this repo. The framework you must use is
named in your instructions. Everything else (libraries, rendering strategy, routing,
data fetching, state management, project structure) is up to you.

Work autonomously until `npm test` passes. Don't stop to ask questions; where this spec
is silent, make a reasonable choice.

## Repository layout

| Path | What it is | May you change it? |
| --- | --- | --- |
| `app/` | **Your app.** Create it. | Yes |
| `api/server.mjs` | Local PokeAPI server | No |
| `data/` | PokeAPI data served by the API server | No |
| `tests/` | Acceptance tests | No |
| `design/` | `tokens.css` and reference screenshots | No |

Your work is judged from `app/` only. The harness runs its own copies of `api/`, `data/`,
`tests/` and `design/`, so changes to them have no effect.

## How the app is run

`app/package.json` must define:

- `npm run build`: produce a production build. If your app has no build step, this can be a no-op.
- `npm start`: serve the production build (not a dev server) on port `$PORT` (default `3000`).

Both commands receive `API_BASE_URL` (default `http://localhost:9000`), the origin of the
API server. The browser can reach the API at that same URL. Run `npm install` in `app/`
before either command; the harness does the same.

Assume a reverse proxy will sit in front of your server in production and handle HTTPS,
HTTP/2 and compression. Don't implement any of those.

## The API

Start it with `npm run api` from the repo root. It listens on `http://localhost:9000` and
behaves like `https://pokeapi.co/api/v2/` ([docs](https://pokeapi.co/docs/v2)), with these
differences:

- It serves a fixed snapshot of the data. There are no other endpoints (no GraphQL, no search).
- Media lives on the same server under `/media/`. Sprite and artwork URLs in the data
  point there. URLs for sprite sets that aren't shipped are `null`, as the real API does
  for missing sprites. Shipped sets: `sprites/pokemon/*.png` (front default),
  `back/`, `shiny/`, `female/`, `other/official-artwork/`, `other/home/`,
  `other/dream-world/`, plus `sprites/types/` and `sprites/items/`. Front sprites
  follow the pattern `/media/sprites/pokemon/<pokemon id>.png`.
- `pokeapi.co` is unreachable from this environment.

You may read the files under `data/` while developing, to learn the data's shape, but
**the app must get all of its data from the API over HTTP at request time.** Don't read
`data/` from the app, and don't fetch, prerender or embed API data at build time. Treat
the API as a live service whose data can change at any moment. Caching API responses in
memory at runtime is fine.

The tests enforce this: they build your app against the normal API, then run it against
an API that serves slightly different data (`tests/fixtures/live-data-overlay.json`),
including one extra Pokémon.

## Definitions

- **Species**: an entry in `/pokemon-species/`. The app covers every species the API
  lists (currently 1,025). A species' default Pokémon has the same ID as the species, so
  species `25` ↔ `/pokemon/25/`. Alternate forms (Pokémon IDs above 10000, such as
  Mega Evolutions) are out of scope: leave them out of every list.
- **Dex number**: the species ID, shown as `#` plus four zero-padded digits (`#0025`).
- **English name**: the `names` entry whose `language.name` is `en`.
- **Humanized name**: an API name with each `-`-separated word capitalized and joined by
  spaces (`mr-mime` → `Mr Mime`, `thunder-punch` → `Thunder Punch`).
- **Display name rule**: a page's main heading uses the English name of the resource the
  page is about. Wherever the app only has a reference to a resource (an entry in a list),
  it shows the humanized name. Exceptions are called out below.
- **Latest English flavor text**: the last entry in `flavor_text_entries` whose language is
  `en`, with every run of whitespace (including `\n` and `\f`) collapsed to a single space.
- **The 18 types**: every type in `/type/` except `stellar`, `unknown` and `shadow`.
- **Missing values** (for example a move with no power) are shown as `—` (em dash).

## Pages

URLs use API names: species names for Pokémon (`/pokemon/deoxys`, not
`/pokemon/deoxys-normal`), and move, ability and type names for the rest.

### Every page

- `<html lang="en">`.
- A `banner` landmark containing a link named `Pokédex` to `/`, and a `navigation`
  landmark with links `Pokémon` (`/`) and `Types` (`/types`).
- One `main` landmark containing exactly one `h1`.
- A `contentinfo` landmark with the text: `Data from PokéAPI. Pokémon and Pokémon
  character names are trademarks of Nintendo.`
- The document title is `<h1 text> – Pokédex` (an en dash with spaces around it).
  The home page's title is just `Pokédex`.
- A **section** means an element with the `region` role whose accessible name is its
  heading, for example `<section aria-labelledby="stats-heading">` containing
  `<h2 id="stats-heading">Base stats</h2>`.
- A **Pokémon card** is a link to `/pokemon/<species name>` containing the front sprite,
  the dex number and the humanized species name. A list of cards is a `list` with one
  card per `listitem`, ordered by dex number. Note that type, move and ability data refer
  to Pokémon, not species (`deoxys-normal`, ID 386); the card still shows and links to
  the species (`Deoxys`, `/pokemon/deoxys`).

### `/` – Pokémon list

- `h1`: `Pokémon`.
- Controls, all native form elements with visible labels:
  - a search input (`type="search"`) labelled `Search`
  - a `<select>` labelled `Type`: `All types` followed by the 18 types (English names)
  - a `<select>` labelled `Generation`: `All generations`, then `Generation I` …
    `Generation IX`, in that order (the English names from `/generation/`)
- The page shows every species matching all active filters, as a list of Pokémon cards.
  On this page each card **also shows the Pokémon's types**, in slot order.
- **Search** is a case-insensitive substring match against the humanized name. Results
  update as the user types, without pressing Enter (debouncing up to 300 ms is fine).
- **Type** keeps species whose default Pokémon has that type in either slot.
- **Generation** keeps species introduced in that generation.
- Results are paginated, **48 per page**. Below the list: the text `Page <n> of <total>`
  plus links named `Previous page` and `Next page`. Leave out `Previous page` on the
  first page and `Next page` on the last.
- Above the list, the text `<count> Pokémon` gives the number of matching species across
  all pages (`1025 Pokémon` with no filters). With no matches, show `No Pokémon found`
  in place of the list.
- Filter state lives in the URL query: `q`, `type` (a type API name), `generation`
  (a generation API name, such as `generation-i`) and `page` (1-based). Loading
  `/?type=fire&generation=generation-i` shows that filtered view. Changing a filter
  updates the URL (pushing or replacing a history entry) and goes back to page 1.
  Omit parameters that are empty or at their default.

### `/pokemon/:name` – Pokémon page

- `h1`: the species' English name (`Mr. Mime`).
- Near the top (not in a section): the dex number; the English genus (`Mouse Pokémon`);
  the types as links to `/types/<type>`, labelled with English type names; the
  official artwork (`<img>` whose alt text is the English name); and a description list
  with `Height` (in metres, one decimal place: `0.4 m`) and `Weight` (in kilograms,
  one decimal place: `6.0 kg`). Then the latest English flavor text of the species.
- Section `Base stats`: a `table` with one row per stat, in API order, plus a final
  `Total` row with the sum. Each row's first cell is a row header with the stat's label:
  `HP`, `Attack`, `Defense`, `Sp. Atk`, `Sp. Def`, `Speed`. The second cell holds the
  number. A visual bar per stat is shown in the screenshots.
- Section `Abilities`: a list of links to `/abilities/<name>`, labelled with humanized
  names, in slot order. A hidden ability is followed by the text `(hidden)`, outside the link.
- Section `Evolution`: every species in the species' evolution chain (including the
  species itself) as links to `/pokemon/<species name>`, labelled with humanized
  names. Show the chain's structure: a nested list where each species' evolutions are a
  list inside its list item (branching chains such as Eevee's have several).
  Evolution conditions are not required.
- Section `Moves`, with `id="moves"` so `/pokemon/pikachu#moves` jumps to it:
  - A `<select>` labelled `Game`, with one option per version group in which the
    Pokémon learns moves, ordered by the version group's `order`, labelled with humanized
    names. The default is the one with the highest `order`. The selection is reflected
    in the URL query as `game=<version group name>`; loading the page with `?game=...`
    selects that version group.
  - For the selected version group, one `table` per learn method, each with an accessible
    name equal to the humanized method name (`Level Up`, `Machine`, `Egg`, `Tutor`, …,
    for example via `<caption>`). Order: `Level Up`, `Machine`, `Egg`, `Tutor`, then any
    others alphabetically. Leave out methods with no moves.
  - Columns, in order: `Level` (only in the `Level Up` table), `Move` (a link to
    `/moves/<name>`, labelled with the move's English name), `Type` (a link to the type,
    English name), `Category` (the humanized damage class: `Physical`, `Special`,
    `Status`), `Power`, `Accuracy` (a number, no `%`), `PP`.
  - Default order: `Level Up` by level, then move name; the other tables by move name.
  - Every column header is sortable. Clicking it sorts that table by the column
    (ascending first; a second click flips it). The sorted header has `aria-sort` set to
    `ascending` or `descending`; the other headers in that table have no `aria-sort` (or
    `aria-sort="none"`).
    Missing values sort last in both directions. Sorting doesn't need to be in the URL.

### `/moves/:name` – Move page

- `h1`: the move's English name.
- A description list: `Type` (a link, English name), `Category`, `Power`, `Accuracy`, `PP`.
- Section `Effect`: the English `short_effect` from `effect_entries`. If there is none,
  use the latest English flavor text; if that's missing too, `—`.
- Section `Learned by`: the text `<count> Pokémon`, then a list of Pokémon cards for
  every Pokémon in `learned_by_pokemon` (alternate forms excluded).

### `/abilities/:name` – Ability page

- `h1`: the ability's English name.
- Section `Effect`: the English `short_effect`.
- Section `Pokémon`: the text `<count> Pokémon`, then a list of Pokémon cards for every
  Pokémon with this ability (alternate forms excluded). Cards for Pokémon that have it as
  a hidden ability also contain the text `Hidden ability`.

### `/types` – Type list

- `h1`: `Types`.
- A list of links to `/types/<name>` for the 18 types, in API order, labelled with English names.

### `/types/:name` – Type page

- `h1`: the type's English name.
- Section `Damage relations`: a description list with these terms, in order, each followed
  by links to the related types (English names), or the text `None` if there are none:
  `Super effective against` (`double_damage_to`), `Not very effective against`
  (`half_damage_to`), `No effect against` (`no_damage_to`), `Weak to`
  (`double_damage_from`), `Resists` (`half_damage_from`), `Immune to` (`no_damage_from`).
- Section `Pokémon`: the text `<count> Pokémon`, then a list of Pokémon cards for every
  Pokémon of this type (alternate forms excluded).
- Section `Moves`: the text `<count> moves`, then a list of links to `/moves/<name>`,
  labelled with humanized names, sorted alphabetically by name.

### Not found

Any URL that doesn't match a page above, or names a Pokémon, move, ability or type the
API doesn't have, shows a page whose `h1` is `Not found`, plus a link to `/`. Responding
with HTTP status 404 is encouraged where your architecture allows it, but isn't tested.

## Look and feel

The app must look like the reference screenshots in `design/screenshots/`. Each page is
captured at a mobile width (412 px, `*-mobile.png`) and a desktop width (1280 px,
`*-desktop.png`), with long pages cut off at 4000 px. Match layout, spacing, colors and
typography closely; pixel-for-pixel equality isn't required.

| Screenshot | URL |
| --- | --- |
| `home` | `/` |
| `home-filtered` | `/?type=fire&generation=generation-i` |
| `pokemon` | `/pokemon/pikachu` |
| `pokemon-moves` | `/pokemon/pikachu?game=scarlet-violet#moves` (the viewport after jumping to `#moves`) |
| `move` | `/moves/thunderbolt` |
| `ability` | `/abilities/static` |
| `types` | `/types` |
| `type` | `/types/fire` |
| `not-found` | `/pokemon/missingno` |

- Use the custom properties in `design/tokens.css` for colors, spacing and type sizes.
  Copy the file into your app or import it, whichever suits your framework.
- Write your own CSS, in whatever way your framework favors (plain CSS, CSS modules,
  scoped styles, CSS-in-JS). Don't use a CSS framework or UI component library
  (such as Tailwind, Bootstrap or MUI).
- Use the system font stack in `tokens.css`. No web fonts and no icon fonts.
- No animations or transitions.
- Light theme only.

## Environment

- Node.js 24 and npm. You may install other package managers or tools.
- [`agent-browser`](https://github.com/vercel-labs/agent-browser) is installed for looking
  at pages in a headless browser (run `agent-browser --help`). Playwright's Chromium is
  installed for the tests.
- You have internet access (npm, documentation, web search), except for `pokeapi.co`.

## Constraints

- The app must work in the latest Chromium. Other browsers don't matter.
- Shadow DOM is allowed, but no closed shadow roots.
- Service workers, offline support and the like are optional.
- You may use npm packages, web search and documentation as you see fit.

## Tests

Run `npm test` from the repo root. It installs and builds `app/`, starts the API and your
app on separate ports (so they don't conflict with anything you're running), and runs the
Playwright tests in `tests/`. Extra arguments go to Playwright, for example
`npm test -- --grep "Pokémon page"`.

The tests check what the page exposes to assistive technology (roles, accessible names,
text) and the URLs; they don't check your HTML structure. You're done when `npm test`
passes in full.
