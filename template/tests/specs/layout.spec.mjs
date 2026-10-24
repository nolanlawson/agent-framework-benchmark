import { test, expect } from '@playwright/test';
import { main, expectHref } from './helpers.mjs';

const PAGES = [
  ['/', 'Pokémon', 'Pokédex'],
  ['/pokemon/pikachu', 'Pikachu', 'Pikachu – Pokédex'],
  ['/moves/thunderbolt', 'Thunderbolt', 'Thunderbolt – Pokédex'],
  ['/abilities/static', 'Static', 'Static – Pokédex'],
  ['/types', 'Types', 'Types – Pokédex'],
  ['/types/fire', 'Fire', 'Fire – Pokédex'],
  ['/pokemon/missingno', 'Not found', 'Not found – Pokédex'],
];

test.describe('Every page', () => {
  for (const [url, h1, title] of PAGES) {
    test(`${url} has the shared layout`, async ({ page }) => {
      await page.goto(url);
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(h1);
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page).toHaveTitle(title);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');

      const home = page.getByRole('banner').getByRole('link', { name: 'Pokédex', exact: true });
      await expect(home).toBeVisible();
      await expectHref(home, '/');

      const nav = page.getByRole('navigation').filter({ has: page.getByRole('link', { name: 'Types', exact: true }) });
      await expectHref(nav.getByRole('link', { name: 'Pokémon', exact: true }), '/');
      await expectHref(nav.getByRole('link', { name: 'Types', exact: true }), '/types');

      await expect(page.getByRole('contentinfo')).toContainText(
        'Data from PokéAPI. Pokémon and Pokémon character names are trademarks of Nintendo.',
      );
    });
  }
});
