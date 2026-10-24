// Captures reference screenshots of an app: node bench/screenshots.mjs <baseURL> <outDir>
import { chromium } from '/mnt/template/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const [base = 'http://localhost:3000', out = 'screenshots'] = process.argv.slice(2);
export const PAGES = {
  home: '/',
  'home-filtered': '/?type=fire&generation=generation-i',
  pokemon: '/pokemon/pikachu',
  'pokemon-moves': '/pokemon/pikachu?game=scarlet-violet#moves',
  move: '/moves/thunderbolt',
  ability: '/abilities/static',
  types: '/types',
  type: '/types/fire',
  'not-found': '/pokemon/missingno',
};
const VIEWPORTS = { mobile: { width: 412, height: 915 }, desktop: { width: 1280, height: 800 } };
const MAX_HEIGHT = 4000;

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  for (const [name, path] of Object.entries(PAGES)) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    const anchored = path.includes('#');
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const clip = anchored
      ? undefined
      : { x: 0, y: 0, width: viewport.width, height: Math.min(height, MAX_HEIGHT) };
    await page.screenshot({ path: `${out}/${name}-${vpName}.png`, fullPage: !anchored, clip });
  }
  await page.close();
}
await browser.close();
console.log(`Saved screenshots to ${out}`);
