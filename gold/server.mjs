// Gold-standard Pokédex implementation (harness only; never shown to agents).
// A dependency-free Node server that renders every page to HTML, with a small client
// script (public/app.js) for live search and table sorting.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const API = (process.env.API_BASE_URL ?? 'http://localhost:9000').replace(/\/$/, '');
const PAGE_SIZE = 48;
const EXCLUDED_TYPES = new Set(['stellar', 'unknown', 'shadow']);
const LEARN_METHOD_ORDER = ['level-up', 'machine', 'egg', 'tutor'];

const STATIC = {
  '/styles.css': [path.join(ROOT, 'public/styles.css'), 'text/css'],
  '/app.js': [path.join(ROOT, 'public/app.js'), 'text/javascript'],
  '/tokens.css': [path.join(ROOT, '../template/design/tokens.css'), 'text/css'],
};

// ---------- API access ----------

class NotFound extends Error {}

const cache = new Map();
function api(pathname) {
  const url = pathname.startsWith('http') ? pathname : `${API}/api/v2/${pathname}`;
  if (!cache.has(url)) {
    const p = fetch(url).then((res) => {
      if (res.status === 404) throw new NotFound(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return res.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

const idFromUrl = (url) => Number(url.match(/\/(\d+)\/$/)[1]);
const en = (entries, key = 'name') => entries?.find((e) => e.language.name === 'en')?.[key];
const humanize = (name) =>
  name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
const dexNumber = (id) => `#${String(id).padStart(4, '0')}`;
const spriteUrl = (id) => `${API}/media/sprites/pokemon/${id}.png`;
const latestFlavor = (entries) => {
  const text = entries.filter((e) => e.language.name === 'en').at(-1)?.flavor_text;
  return text ? text.replace(/\s+/g, ' ').trim() : undefined;
};

async function allSpecies() {
  const list = await api('pokemon-species/?limit=100000');
  return list.results.map((s) => ({ id: idFromUrl(s.url), name: s.name })).sort((a, b) => a.id - b.id);
}

async function speciesById() {
  return new Map((await allSpecies()).map((s) => [s.id, s]));
}

async function allTypes() {
  const list = await api('type/?limit=100');
  const types = await Promise.all(list.results.filter((t) => !EXCLUDED_TYPES.has(t.name)).map((t) => api(`type/${t.name}`)));
  return types.map((t) => ({ name: t.name, label: en(t.names), data: t }));
}

async function typeLabels() {
  return new Map((await allTypes()).map((t) => [t.name, t.label]));
}

// Pokémon id -> type names in slot order, built from the 18 type endpoints.
async function typesByPokemon() {
  const map = new Map();
  for (const t of await allTypes()) {
    for (const { slot, pokemon } of t.data.pokemon) {
      const id = idFromUrl(pokemon.url);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push({ slot, name: t.name });
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.slot - b.slot);
  return map;
}

// Maps a list of Pokémon references to their species, dropping alternate forms.
async function toSpecies(refs) {
  const species = await speciesById();
  return refs
    .map((ref) => ({ ref, species: species.get(idFromUrl(ref.pokemon?.url ?? ref.url)) }))
    .filter((x) => x.species)
    .sort((a, b) => a.species.id - b.species.id);
}

// ---------- HTML helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class Raw {
  constructor(value) {
    this.value = value;
  }
}
const raw = (v) => (v instanceof Raw ? v : new Raw(Array.isArray(v) ? fragment(v) : v));
const fragment = (v) =>
  v instanceof Raw ? v.value : Array.isArray(v) ? v.map(fragment).join('') : v === null || v === undefined || v === false ? '' : esc(v);

// Tagged template that escapes interpolated values; nested html`` results pass through.
function html(strings, ...values) {
  return new Raw(strings.reduce((out, s, i) => out + fragment(values[i - 1]) + s));
}
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

function layout({ title, body, status = 200 }) {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/styles.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<header class="site-header">
  <div class="site-header__inner">
    <a class="site-header__brand" href="/">Pokédex</a>
    <nav aria-label="Main">
      <ul class="site-nav">
        <li><a href="/">Pokémon</a></li>
        <li><a href="/types">Types</a></li>
      </ul>
    </nav>
  </div>
</header>
<main class="page">
${raw(body)}
</main>
<footer class="site-footer">
  <p>Data from PokéAPI. Pokémon and Pokémon character names are trademarks of Nintendo.</p>
</footer>
</body>
</html>`;
  return { status, body: doc.value };
}

const pageTitle = (h1) => `${h1} – Pokédex`;

const typeBadge = (name, label, link = false) =>
  link
    ? html`<a class="type-badge" style="--badge-color: var(--type-${name})" href="/types/${name}">${label}</a>`
    : html`<span class="type-badge" style="--badge-color: var(--type-${name})">${label}</span>`;

function pokemonCard(species, { types, labels, extra } = {}) {
  return html`<li>
  <a class="card" href="/pokemon/${species.name}">
    <img class="card__sprite" src="${spriteUrl(species.id)}" alt="" width="96" height="96">
    <span class="card__number">${dexNumber(species.id)}</span>
    <span class="card__name">${humanize(species.name)}</span>
    ${types ? raw(html`<span class="card__types">${types.map((t) => typeBadge(t.name, labels.get(t.name)))}</span>`) : ''}
    ${extra ? raw(html`<span class="card__extra">${extra}</span>`) : ''}
  </a>
</li>`;
}

const section = (id, heading, content) =>
  html`<section class="panel" aria-labelledby="${id}-heading">
  <h2 id="${id}-heading">${heading}</h2>
  ${raw(content)}
</section>`;

// ---------- Pages ----------

async function homePage(url) {
  const q = (url.searchParams.get('q') ?? '').trim();
  const type = url.searchParams.get('type') ?? '';
  const generation = url.searchParams.get('generation') ?? '';
  const [species, types, labels, generations] = await Promise.all([
    allSpecies(),
    typesByPokemon(),
    typeLabels(),
    api('generation/?limit=100').then((l) => Promise.all(l.results.map((g) => api(`generation/${g.name}`)))),
  ]);
  const gen = generations.find((g) => g.name === generation);
  const genIds = gen && new Set(gen.pokemon_species.map((s) => idFromUrl(s.url)));
  const needle = q.toLowerCase();

  const matches = species.filter(
    (s) =>
      (!needle || humanize(s.name).toLowerCase().includes(needle)) &&
      (!type || types.get(s.id)?.some((t) => t.name === type)) &&
      (!genIds || genIds.has(s.id)),
  );
  const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1), totalPages);
  const shown = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pageLink = (n) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (type) params.set('type', type);
    if (generation) params.set('generation', generation);
    if (n > 1) params.set('page', n);
    const s = params.toString();
    return s ? `/?${s}` : '/';
  };

  const body = html`<h1>Pokémon</h1>
<form class="filters" action="/" method="get" data-live-filters>
  <div class="field field--search">
    <label for="q">Search</label>
    <input id="q" name="q" type="search" value="${q}" autocomplete="off">
  </div>
  <div class="field">
    <label for="type">Type</label>
    <select id="type" name="type">
      <option value="">All types</option>
      ${[...labels].map(([name, label]) => html`<option value="${name}"${raw(name === type ? ' selected' : '')}>${label}</option>`)}
    </select>
  </div>
  <div class="field">
    <label for="generation">Generation</label>
    <select id="generation" name="generation">
      <option value="">All generations</option>
      ${generations.map((g) => html`<option value="${g.name}"${raw(g.name === generation ? ' selected' : '')}>${en(g.names)}</option>`)}
    </select>
  </div>
</form>
<div id="results">
  <p class="count">${matches.length} Pokémon</p>
  ${
    matches.length
      ? raw(html`<ul class="card-grid">${shown.map((s) => pokemonCard(s, { types: types.get(s.id) ?? [], labels }))}</ul>
  <nav class="pagination" aria-label="Pagination">
    ${page > 1 ? raw(html`<a href="${pageLink(page - 1)}">Previous page</a>`) : ''}
    <span>Page ${page} of ${totalPages}</span>
    ${page < totalPages ? raw(html`<a href="${pageLink(page + 1)}">Next page</a>`) : ''}
  </nav>`)
      : raw(html`<p class="empty">No Pokémon found</p>`)
  }
</div>`;
  return layout({ title: 'Pokédex', body });
}

function evolutionTree(node) {
  const name = node.species.name;
  return html`<li><a href="/pokemon/${name}">${humanize(name)}</a>${
    node.evolves_to.length ? raw(html`<ul>${node.evolves_to.map(evolutionTree)}</ul>`) : ''
  }</li>`;
}

const STAT_LABELS = { hp: 'HP', attack: 'Attack', defense: 'Defense', 'special-attack': 'Sp. Atk', 'special-defense': 'Sp. Def', speed: 'Speed' };

async function pokemonPage(name, url) {
  const species = await api(`pokemon-species/${encodeURIComponent(name)}`);
  const [pokemon, chain, labels] = await Promise.all([
    api(`pokemon/${species.id}`),
    api(species.evolution_chain.url),
    typeLabels(),
  ]);
  const title = en(species.names);

  // Version groups the Pokémon learns moves in, ordered by `order`.
  const vgNames = [...new Set(pokemon.moves.flatMap((m) => m.version_group_details.map((d) => d.version_group.name)))];
  const vgs = (await Promise.all(vgNames.map((n) => api(`version-group/${n}`)))).sort((a, b) => a.order - b.order);
  const requested = url.searchParams.get('game');
  const game = vgs.find((v) => v.name === requested)?.name ?? vgs.at(-1)?.name;

  const learned = pokemon.moves.flatMap((m) =>
    m.version_group_details.filter((d) => d.version_group.name === game).map((d) => ({ move: m.move.name, method: d.move_learn_method.name, level: d.level_learned_at })),
  );
  const moves = new Map(await Promise.all([...new Set(learned.map((l) => l.move))].map(async (n) => [n, await api(`move/${n}`)])));
  const methods = [...new Set(learned.map((l) => l.method))].sort((a, b) => {
    const ia = LEARN_METHOD_ORDER.indexOf(a), ib = LEARN_METHOD_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });

  const moveTable = (method) => {
    const isLevel = method === 'level-up';
    const rows = learned
      .filter((l) => l.method === method)
      .map((l) => ({ ...l, data: moves.get(l.move), label: en(moves.get(l.move).names) ?? humanize(l.move) }))
      .sort((a, b) => (isLevel ? a.level - b.level : 0) || a.label.localeCompare(b.label));
    const columns = [...(isLevel ? ['Level'] : []), 'Move', 'Type', 'Category', 'Power', 'Accuracy', 'PP'];
    return html`<div class="table-scroll">
<table class="moves-table" data-sortable>
  <caption>${humanize(method)}</caption>
  <thead><tr>${columns.map((c) => html`<th scope="col"><button type="button">${c}</button></th>`)}</tr></thead>
  <tbody>${rows.map(
    (r) => html`<tr>
    ${isLevel ? raw(html`<td data-value="${r.level}">${r.level}</td>`) : ''}
    <td data-value="${r.label}"><a href="/moves/${r.move}">${r.label}</a></td>
    <td data-value="${labels.get(r.data.type.name) ?? humanize(r.data.type.name)}">${typeBadge(r.data.type.name, labels.get(r.data.type.name) ?? humanize(r.data.type.name), true)}</td>
    <td data-value="${humanize(r.data.damage_class.name)}">${humanize(r.data.damage_class.name)}</td>
    <td data-value="${r.data.power ?? ''}">${dash(r.data.power)}</td>
    <td data-value="${r.data.accuracy ?? ''}">${dash(r.data.accuracy)}</td>
    <td data-value="${r.data.pp ?? ''}">${dash(r.data.pp)}</td>
  </tr>`,
  )}</tbody>
</table>
</div>`;
  };

  const total = pokemon.stats.reduce((sum, s) => sum + s.base_stat, 0);
  const statRow = (label, value, max) => html`<tr>
    <th scope="row">${label}</th>
    <td>${value}</td>
    <td class="stat-bar-cell" aria-hidden="true"><span class="stat-bar"><span style="width: ${Math.min(100, (value / max) * 100).toFixed(1)}%"></span></span></td>
  </tr>`;

  const artwork = pokemon.sprites.other?.['official-artwork']?.front_default;
  const body = html`<div class="hero">
  <div class="hero__art">${artwork ? raw(html`<img src="${artwork}" alt="${title}" width="288" height="288">`) : ''}</div>
  <div class="hero__info">
    <p class="hero__number">${dexNumber(species.id)}</p>
    <h1>${title}</h1>
    <p class="hero__genus">${en(species.genera, 'genus')}</p>
    <p class="type-list">${pokemon.types.map((t) => typeBadge(t.type.name, labels.get(t.type.name) ?? humanize(t.type.name), true))}</p>
    <dl class="facts">
      <div><dt>Height</dt><dd>${(pokemon.height / 10).toFixed(1)} m</dd></div>
      <div><dt>Weight</dt><dd>${(pokemon.weight / 10).toFixed(1)} kg</dd></div>
    </dl>
    <p class="hero__flavor">${latestFlavor(species.flavor_text_entries) ?? '—'}</p>
  </div>
</div>
${raw(
  section(
    'stats',
    'Base stats',
    html`<table class="stats-table">
  <tbody>
    ${pokemon.stats.map((s) => statRow(STAT_LABELS[s.stat.name] ?? humanize(s.stat.name), s.base_stat, 255))}
    ${statRow('Total', total, 1530)}
  </tbody>
</table>`,
  ),
)}
${raw(
  section(
    'abilities',
    'Abilities',
    html`<ul class="plain-list">${[...pokemon.abilities]
      .sort((a, b) => a.slot - b.slot)
      .map((a) => html`<li><a href="/abilities/${a.ability.name}">${humanize(a.ability.name)}</a>${a.is_hidden ? ' (hidden)' : ''}</li>`)}</ul>`,
  ),
)}
${raw(section('evolution', 'Evolution', html`<ul class="evolution">${evolutionTree(chain.chain)}</ul>`))}
<section class="panel" id="moves" aria-labelledby="moves-heading">
  <h2 id="moves-heading">Moves</h2>
  ${
    vgs.length
      ? raw(html`<form class="field field--inline" action="#moves" method="get" data-game-select>
    <label for="game">Game</label>
    <select id="game" name="game">${vgs.map((v) => html`<option value="${v.name}"${raw(v.name === game ? ' selected' : '')}>${humanize(v.name)}</option>`)}</select>
  </form>
  ${methods.map(moveTable)}`)
      : raw(html`<p>—</p>`)
  }
</section>`;
  return layout({ title: pageTitle(title), body });
}

async function movePage(name) {
  const [move, labels] = await Promise.all([api(`move/${encodeURIComponent(name)}`), typeLabels()]);
  const title = en(move.names) ?? humanize(move.name);
  const learners = await toSpecies(move.learned_by_pokemon);
  const effect = en(move.effect_entries, 'short_effect') ?? latestFlavor(move.flavor_text_entries) ?? '—';
  const body = html`<h1>${title}</h1>
<dl class="facts facts--panel">
  <div><dt>Type</dt><dd>${typeBadge(move.type.name, labels.get(move.type.name) ?? humanize(move.type.name), true)}</dd></div>
  <div><dt>Category</dt><dd>${humanize(move.damage_class.name)}</dd></div>
  <div><dt>Power</dt><dd>${dash(move.power)}</dd></div>
  <div><dt>Accuracy</dt><dd>${dash(move.accuracy)}</dd></div>
  <div><dt>PP</dt><dd>${dash(move.pp)}</dd></div>
</dl>
${raw(section('effect', 'Effect', html`<p>${effect}</p>`))}
${raw(
  section(
    'learned-by',
    'Learned by',
    html`<p class="count">${learners.length} Pokémon</p><ul class="card-grid">${learners.map((l) => pokemonCard(l.species))}</ul>`,
  ),
)}`;
  return layout({ title: pageTitle(title), body });
}

async function abilityPage(name) {
  const ability = await api(`ability/${encodeURIComponent(name)}`);
  const title = en(ability.names) ?? humanize(ability.name);
  const holders = await toSpecies(ability.pokemon);
  const body = html`<h1>${title}</h1>
${raw(section('effect', 'Effect', html`<p>${en(ability.effect_entries, 'short_effect') ?? '—'}</p>`))}
${raw(
  section(
    'pokemon',
    'Pokémon',
    html`<p class="count">${holders.length} Pokémon</p><ul class="card-grid">${holders.map((h) =>
      pokemonCard(h.species, { extra: h.ref.is_hidden ? 'Hidden ability' : '' }),
    )}</ul>`,
  ),
)}`;
  return layout({ title: pageTitle(title), body });
}

async function typesPage() {
  const types = await allTypes();
  const body = html`<h1>Types</h1>
<ul class="type-index">${types.map((t) => html`<li>${typeBadge(t.name, t.label, true)}</li>`)}</ul>`;
  return layout({ title: pageTitle('Types'), body });
}

const RELATIONS = [
  ['Super effective against', 'double_damage_to'],
  ['Not very effective against', 'half_damage_to'],
  ['No effect against', 'no_damage_to'],
  ['Weak to', 'double_damage_from'],
  ['Resists', 'half_damage_from'],
  ['Immune to', 'no_damage_from'],
];

async function typePage(name) {
  const [type, labels] = await Promise.all([api(`type/${encodeURIComponent(name)}`), typeLabels()]);
  const title = en(type.names) ?? humanize(type.name);
  const members = await toSpecies(type.pokemon);
  const moves = [...type.moves].sort((a, b) => a.name.localeCompare(b.name));
  const body = html`<h1>${title}</h1>
${raw(
  section(
    'relations',
    'Damage relations',
    html`<dl class="relations">${RELATIONS.map(
      ([label, key]) => html`<div><dt>${label}</dt><dd>${
        type.damage_relations[key].length
          ? raw(type.damage_relations[key].map((t) => typeBadge(t.name, labels.get(t.name) ?? humanize(t.name), true)))
          : 'None'
      }</dd></div>`,
    )}</dl>`,
  ),
)}
${raw(
  section(
    'pokemon',
    'Pokémon',
    html`<p class="count">${members.length} Pokémon</p><ul class="card-grid">${members.map((m) => pokemonCard(m.species))}</ul>`,
  ),
)}
${raw(
  section(
    'moves',
    'Moves',
    html`<p class="count">${moves.length} moves</p><ul class="link-columns">${moves.map((m) => html`<li><a href="/moves/${m.name}">${humanize(m.name)}</a></li>`)}</ul>`,
  ),
)}`;
  return layout({ title: pageTitle(title), body });
}

function notFoundPage() {
  return layout({
    status: 404,
    title: pageTitle('Not found'),
    body: html`<h1>Not found</h1><p><a href="/">Back to the Pokédex</a></p>`,
  });
}

// ---------- Server ----------

async function route(url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return homePage(url);
  if (parts.length === 1 && parts[0] === 'types') return typesPage();
  if (parts.length === 2) {
    const [kind, name] = parts;
    if (kind === 'pokemon') return pokemonPage(name, url);
    if (kind === 'moves') return movePage(name);
    if (kind === 'abilities') return abilityPage(name);
    if (kind === 'types') return typePage(name);
  }
  return notFoundPage();
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const asset = STATIC[url.pathname];
    if (asset) {
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
      return fs.createReadStream(asset[0]).pipe(res);
    }
    let page;
    try {
      page = await route(url);
    } catch (err) {
      if (!(err instanceof NotFound)) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Internal error');
      }
      page = notFoundPage();
    }
    res.writeHead(page.status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page.body);
  })
  .listen(PORT, () => console.log(`Gold Pokédex on http://localhost:${PORT} (API ${API})`));
