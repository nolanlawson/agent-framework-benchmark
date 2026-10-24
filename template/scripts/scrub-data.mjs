#!/usr/bin/env node
// Copies the PokeAPI JSON dump from <src> into <dest>, rewriting media URLs that point at
// raw.githubusercontent.com to root-relative /media/... paths served by api/server.mjs.
// URLs for media files that are not present under <dest>/media become null, the same
// way the real API reports a missing sprite.
//
// Usage: node scripts/scrub-data.mjs <api-data>/data <dest>

import fs from 'node:fs/promises';
import path from 'node:path';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('Usage: scrub-data.mjs <src> <dest>');
  process.exit(1);
}

const mediaDir = path.join(dest, 'media');
const mediaFiles = new Set(
  (await fs.readdir(mediaDir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(mediaDir, path.join(e.parentPath, e.name)).split(path.sep).join('/')),
);

const MEDIA_URL = /"https:\/\/raw\.githubusercontent\.com\/PokeAPI\/(?:sprites\/master\/(sprites\/[^"]+)|cries\/main\/(cries\/[^"]+))"/g;

const stats = { files: 0, kept: 0, nulled: 0 };
function rewrite(_, sprite, cry) {
  const rel = sprite ?? cry;
  if (mediaFiles.has(rel)) {
    stats.kept++;
    return `"/media/${rel}"`;
  }
  stats.nulled++;
  return 'null';
}

async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    const to = path.join(dest, path.relative(src, from));
    if (entry.isDirectory()) {
      await fs.mkdir(to, { recursive: true });
      await walk(from);
    } else if (entry.name.endsWith('.json')) {
      const text = (await fs.readFile(from, 'utf8')).replace(MEDIA_URL, rewrite);
      if (/https?:\/\/(raw\.githubusercontent\.com|pokeapi\.co)/.test(text)) {
        throw new Error(`Unrewritten external URL in ${from}`);
      }
      await fs.writeFile(to, text);
      if (++stats.files % 5000 === 0) console.log(`  ${stats.files} files`);
    }
  }
}

await walk(src);
console.log(
  `Scrubbed ${stats.files} JSON files into ${dest}: ${stats.kept} media URLs kept, ${stats.nulled} set to null (not shipped)`,
);
