// Captures screenshots of an app's key pages at mobile and desktop widths.
// CLI: node bench/screenshots.mjs <baseURL> <outDir>

import { chromium } from 'playwright';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
export const VIEWPORTS = { mobile: { width: 412, height: 915 }, desktop: { width: 1280, height: 800 } };
const MAX_HEIGHT = 4000;

export async function capture(base, out) {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
      for (const [name, path] of Object.entries(PAGES)) {
        await page.goto(base + path, { waitUntil: 'networkidle' });
        // Let client-rendered pages and lazy images settle.
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        const anchored = path.includes('#');
        if (!anchored) {
          await page.evaluate(async () => {
            for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
              scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 50));
            }
            scrollTo(0, 0);
          });
          await page.waitForLoadState('networkidle');
        }
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.screenshot({
          path: `${out}/${name}-${vpName}.png`,
          fullPage: !anchored,
          clip: anchored ? undefined : { x: 0, y: 0, width: viewport.width, height: Math.min(height, MAX_HEIGHT) },
          animations: 'disabled',
        });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base = 'http://localhost:3000', out = 'screenshots'] = process.argv.slice(2);
  await capture(base, out);
  console.log(`Saved screenshots to ${out}`);
}
