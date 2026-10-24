#!/usr/bin/env node
// Local PokeAPI server. Serves the static PokeAPI dump in ../data with the same
// URL semantics as https://pokeapi.co/api/v2/ (lookup by id or name, ?limit/&offset
// pagination, absolute URLs in responses) plus the sprite/cry media files.
//
// Env:
//   PORT        port to listen on (default 9000)
//   PUBLIC_URL  origin used for absolute URLs in responses (default http://localhost:$PORT)
//   LATENCY_MS  artificial delay added to every /api/v2 response (default 0)
//   MEDIA_LATENCY_MS  artificial delay added to every /media response (default 0)
//   API_OVERLAY path to a JSON file of changes applied on top of the data (see
//               tests/fixtures/live-data-overlay.json). Keys are "<resource>/" for list
//               endpoints or "<resource>/<id>" for records; values are
//               { "base"?: "<resource>/<id>", "patch": [JSON Patch add/replace/remove ops] }.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const API_DIR = path.join(DATA_DIR, 'api/v2');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

const PORT = Number(process.env.PORT ?? 9000);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);
const MEDIA_LATENCY_MS = Number(process.env.MEDIA_LATENCY_MS ?? 0);
const DEFAULT_LIMIT = 20;

const MIME = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
};

if (!fs.existsSync(API_DIR)) {
  console.error(`No data found at ${API_DIR}. Run the data setup script first.`);
  process.exit(1);
}

// Full (unpaginated) list for each resource, and name -> id lookup tables.
const lists = new Map();
const nameToId = new Map();
for (const resource of fs.readdirSync(API_DIR)) {
  const indexFile = path.join(API_DIR, resource, 'index.json');
  if (!fs.existsSync(indexFile)) continue;
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  if (!Array.isArray(index.results)) continue;
  lists.set(resource, index.results);
  const names = new Map();
  for (const entry of index.results) {
    const id = entry.url.match(/\/(\d+)\/$/)?.[1];
    if (entry.name && id) names.set(entry.name.toLowerCase(), id);
  }
  nameToId.set(resource, names);
}
const rootIndex = fs.readFileSync(path.join(API_DIR, 'index.json'), 'utf8');

// Minimal JSON Patch (RFC 6902 add/replace/remove) for the overlay.
function applyPatch(doc, ops) {
  for (const { op, path: pointer, value } of ops) {
    if (pointer === '') {
      doc = structuredClone(value);
      continue;
    }
    const keys = pointer.split('/').slice(1).map((k) => k.replaceAll('~1', '/').replaceAll('~0', '~'));
    const last = keys.pop();
    const parent = keys.reduce((obj, k) => obj[k], doc);
    if (Array.isArray(parent)) {
      const i = last === '-' ? parent.length : Number(last);
      if (op === 'add') parent.splice(i, 0, structuredClone(value));
      else if (op === 'replace') parent[i] = structuredClone(value);
      else if (op === 'remove') parent.splice(i, 1);
    } else if (op === 'remove') delete parent[last];
    else parent[last] = structuredClone(value);
  }
  return doc;
}

const overlay = process.env.API_OVERLAY ? JSON.parse(fs.readFileSync(process.env.API_OVERLAY, 'utf8')) : {};
for (const [key, { patch }] of Object.entries(overlay)) {
  const resource = key.match(/^([a-z-]+)\/$/)?.[1];
  if (!resource) continue;
  const results = applyPatch({ results: lists.get(resource) }, patch).results;
  lists.set(resource, results);
  for (const entry of results) {
    const id = entry.url.match(/\/(\d+)\/$/)?.[1];
    if (entry.name && id) nameToId.get(resource).set(entry.name.toLowerCase(), id);
  }
}

async function readRecord(resource, id, sub) {
  const key = `${resource}/${id}${sub ? `/${sub}` : ''}`;
  const entry = overlay[key];
  const file = (k) => path.join(API_DIR, ...k.split('/'), 'index.json');
  if (!entry) return fsp.readFile(file(key), 'utf8');
  // Patches apply to "base" if given, otherwise to the record itself.
  const base = JSON.parse(await fsp.readFile(file(entry.base ?? key), 'utf8'));
  return JSON.stringify(applyPatch(base, entry.patch ?? []));
}

// Stored data uses root-relative URLs; the real API returns absolute ones.
const absolutize = (json) => json.replace(/"\/(api\/v2|media)\//g, `"${PUBLIC_URL}/$1/`);

const delay = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : undefined);

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=86400, s-maxage=86400',
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function listPage(resource, url) {
  const all = lists.get(resource);
  const limit = Math.max(0, parseInt(url.searchParams.get('limit') ?? DEFAULT_LIMIT, 10) || DEFAULT_LIMIT);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? 0, 10) || 0);
  const pageUrl = (o) => `${PUBLIC_URL}/api/v2/${resource}/?offset=${o}&limit=${limit}`;
  return absolutize(
    JSON.stringify({
      count: all.length,
      next: offset + limit < all.length ? pageUrl(offset + limit) : null,
      previous: offset > 0 ? pageUrl(Math.max(0, offset - limit)) : null,
      results: all.slice(offset, offset + limit),
    }),
  );
}

async function handleApi(res, url) {
  // /api/v2/<resource>/<id-or-name>/<sub>/ ; trailing slash optional, as on pokeapi.co
  const parts = url.pathname.replace(/^\/api\/v2\/?/, '').split('/').filter(Boolean);
  await delay(LATENCY_MS);

  if (parts.length === 0) return sendJson(res, 200, absolutize(rootIndex));

  const [resource, key, sub] = parts;
  if (!lists.has(resource) || parts.length > 3) return notFound(res);
  if (!key) return sendJson(res, 200, listPage(resource, url));

  const id = /^\d+$/.test(key) ? key : nameToId.get(resource).get(decodeURIComponent(key).toLowerCase());
  if (!id) return notFound(res);
  try {
    sendJson(res, 200, absolutize(await readRecord(resource, id, sub)));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    notFound(res);
  }
}

async function handleMedia(res, url) {
  const rel = decodeURIComponent(url.pathname.replace(/^\/media\//, ''));
  const file = path.resolve(MEDIA_DIR, rel);
  if (!file.startsWith(MEDIA_DIR + path.sep)) return notFound(res);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {}
  if (!stat?.isFile()) return notFound(res);
  await delay(MEDIA_LATENCY_MS);
  res.writeHead(200, {
    ...baseHeaders,
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...baseHeaders, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, baseHeaders);
    return res.end();
  }
  try {
    if (url.pathname.startsWith('/api/v2')) return await handleApi(res, url);
    if (url.pathname.startsWith('/media/')) return await handleMedia(res, url);
    notFound(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, baseHeaders);
    res.end();
  }
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, () => {
  const overlayNote = process.env.API_OVERLAY ? `, overlay ${process.env.API_OVERLAY}` : '';
  console.log(`PokeAPI server listening on ${PUBLIC_URL} (latency ${LATENCY_MS}ms api, ${MEDIA_LATENCY_MS}ms media${overlayNote})`);
});
