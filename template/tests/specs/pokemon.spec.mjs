import { test, expect } from '@playwright/test';
import { main, section, expectText, expectHref, hrefPath, rowCells, clickHeader } from './helpers.mjs';

const PIKACHU_GAMES = [
  'Red Green Japan', 'Blue Japan', 'Red Blue', 'Yellow', 'Gold Silver', 'Crystal', 'Ruby Sapphire', 'Emerald',
  'Colosseum', 'Xd', 'Firered Leafgreen', 'Diamond Pearl', 'Platinum', 'Heartgold Soulsilver', 'Black White',
  'Black 2 White 2', 'X Y', 'Omega Ruby Alpha Sapphire', 'Sun Moon', 'Ultra Sun Ultra Moon',
  'Lets Go Pikachu Lets Go Eevee', 'Sword Shield', 'Brilliant Diamond Shining Pearl', 'Legends Arceus',
  'Scarlet Violet', 'Champions',
];

test.describe('Pokémon page', () => {
  test('shows the summary', async ({ page }) => {
    await page.goto('/pokemon/pikachu');
    const m = main(page);
    await expect(m.getByRole('heading', { level: 1 })).toHaveText('Pikachu');
    await expect(page).toHaveTitle('Pikachu – Pokédex');
    await expect(m.getByText('#0025', { exact: true })).toBeVisible();
    await expect(m.getByText('Mouse Pokémon', { exact: true })).toBeVisible();
    const type = m.getByRole('link', { name: 'Electric', exact: true }).first();
    await expectHref(type, '/types/electric');
    await expect(m.getByRole('img', { name: 'Pikachu', exact: true })).toBeVisible();
    await expect(m.getByRole('term').filter({ hasText: /^Height$/ })).toBeVisible();
    await expectText(m, /Height 0\.4 m/);
    await expectText(m, /Weight 6\.0 kg/);
    await expectText(
      m,
      /Possesses cheek sacs in which it stores electricity\. This clever forest-dweller roasts tough berries with an electric shock before consuming them\./,
    );
  });

  test('uses the English name for the heading', async ({ page }) => {
    await page.goto('/pokemon/mr-mime');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Mr. Mime');
    await expect(page).toHaveTitle('Mr. Mime – Pokédex');
  });

  test('works for species whose default Pokémon has a different name', async ({ page }) => {
    await page.goto('/pokemon/deoxys');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Deoxys');
    await expect(main(page).getByText('#0386', { exact: true })).toBeVisible();
  });

  test('shows base stats in a table', async ({ page }) => {
    await page.goto('/pokemon/charizard');
    const table = section(page, 'Base stats').getByRole('table');
    await expect(table.getByRole('rowheader')).toHaveText(['HP', 'Attack', 'Defense', 'Sp. Atk', 'Sp. Def', 'Speed', 'Total']);
    const expected = { HP: '78', Attack: '84', Defense: '78', 'Sp. Atk': '109', 'Sp. Def': '85', Speed: '100', Total: '534' };
    for (const [stat, value] of Object.entries(expected)) {
      const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: stat, exact: true }) });
      await expect(row.getByRole('cell').first()).toHaveText(value);
    }
  });

  test('lists abilities with the hidden one marked', async ({ page }) => {
    await page.goto('/pokemon/pikachu');
    const abilities = section(page, 'Abilities');
    await expect(abilities.getByRole('link')).toHaveText(['Static', 'Lightning Rod']);
    await expectHref(abilities.getByRole('link', { name: 'Lightning Rod', exact: true }), '/abilities/lightning-rod');
    await expectText(abilities, /Lightning Rod \(hidden\)/);
    await expectText(abilities, /Static(?! \(hidden\))/);
  });

  test('shows the evolution chain as a nested list', async ({ page }) => {
    await page.goto('/pokemon/pikachu');
    const evolution = section(page, 'Evolution');
    await expect(evolution.getByRole('link')).toHaveText(['Pichu', 'Pikachu', 'Raichu']);
    await expectHref(evolution.getByRole('link', { name: 'Raichu' }), '/pokemon/raichu');
    const pichu = evolution.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Pichu', exact: true }) });
    await expect(pichu.getByRole('list').getByRole('link', { name: 'Pikachu', exact: true })).toBeVisible();
    const pikachu = pichu.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Pikachu', exact: true }) });
    await expect(pikachu.getByRole('list').getByRole('link', { name: 'Raichu', exact: true })).toBeVisible();
  });

  test('shows branching evolutions', async ({ page }) => {
    await page.goto('/pokemon/espeon');
    const evolution = section(page, 'Evolution');
    const eevee = evolution.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Eevee', exact: true }) });
    const branches = eevee.getByRole('list').getByRole('link');
    await expect(branches).toHaveCount(8);
    expect((await branches.allInnerTexts()).map((t) => t.trim()).sort()).toEqual(
      ['Espeon', 'Flareon', 'Glaceon', 'Jolteon', 'Leafeon', 'Sylveon', 'Umbreon', 'Vaporeon'],
    );
  });

  test('#moves jumps to the moves section', async ({ page }) => {
    await page.goto('/pokemon/pikachu#moves');
    const heading = section(page, 'Moves').getByRole('heading', { name: 'Moves' });
    await expect(heading).toBeVisible();
    await expect.poll(async () => (await heading.boundingBox())?.y ?? Infinity).toBeLessThan(300);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
  });

  test('defaults to the latest game and lists games in order', async ({ page }) => {
    await page.goto('/pokemon/pikachu');
    const game = section(page, 'Moves').getByLabel('Game', { exact: true });
    await expect(game.locator('option:checked')).toHaveText('Champions');
    const options = (await game.locator('option').allInnerTexts()).map((t) => t.trim());
    expect(options).toEqual(PIKACHU_GAMES);
  });

  test('shows one table per learn method in a fixed order', async ({ page }) => {
    await page.goto('/pokemon/charmander?game=ultra-sun-ultra-moon');
    const moves = section(page, 'Moves');
    await expect(moves.getByLabel('Game', { exact: true }).locator('option:checked')).toHaveText('Ultra Sun Ultra Moon');
    const tables = moves.getByRole('table');
    await expect(tables).toHaveCount(4);
    for (const [i, name] of ['Level Up', 'Machine', 'Egg', 'Tutor'].entries()) {
      await expect(tables.nth(i)).toHaveAccessibleName(name);
    }
    await expect(moves.getByRole('table', { name: 'Level Up' }).getByRole('columnheader')).toHaveText(
      [/^\s*Level/, /^\s*Move/, /^\s*Type/, /^\s*Category/, /^\s*Power/, /^\s*Accuracy/, /^\s*PP/],
    );
    await expect(moves.getByRole('table', { name: 'Machine' }).getByRole('columnheader')).toHaveText(
      [/^\s*Move/, /^\s*Type/, /^\s*Category/, /^\s*Power/, /^\s*Accuracy/, /^\s*PP/],
    );
  });

  test('shows move details in each row', async ({ page }) => {
    await page.goto('/pokemon/pikachu?game=scarlet-violet');
    const levelUp = section(page, 'Moves').getByRole('table', { name: 'Level Up' });
    const row = levelUp.getByRole('row').filter({ has: page.getByRole('link', { name: 'Thunderbolt', exact: true }) });
    // Thunderbolt's power is 95 in the live-data overlay (90 at build time).
    await expect.poll(() => rowCells(row)).toEqual(['36', 'Thunderbolt', 'Electric', 'Special', '95', '100', '15']);
    await expectHref(row.getByRole('link', { name: 'Thunderbolt' }), '/moves/thunderbolt');
    await expectHref(row.getByRole('link', { name: 'Electric' }), '/types/electric');

    const growl = levelUp.getByRole('row').filter({ has: page.getByRole('link', { name: 'Growl', exact: true }) });
    await expect.poll(() => rowCells(growl)).toEqual(['1', 'Growl', 'Normal', 'Status', '—', '100', '40']);

    const first = await rowCells(levelUp.getByRole('row').nth(1));
    expect(first[0]).toBe('1');
    const levels = await Promise.all((await levelUp.getByRole('row').all()).slice(1).map(async (r) => Number((await rowCells(r))[0])));
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  test('sorts a table by clicking a column header', async ({ page }) => {
    await page.goto('/pokemon/pikachu?game=scarlet-violet');
    const table = section(page, 'Moves').getByRole('table', { name: 'Level Up' });
    const power = table.getByRole('columnheader', { name: /^\s*Power/ });
    const powers = async () => {
      const rows = (await table.getByRole('row').all()).slice(1);
      return Promise.all(rows.map(async (r) => (await rowCells(r))[4]));
    };
    const check = (values, dir) => {
      const present = values.filter((v) => v !== '—').map(Number);
      const missingStart = values.indexOf('—');
      if (missingStart !== -1) expect(values.slice(missingStart).every((v) => v === '—')).toBe(true);
      expect(present).toEqual([...present].sort((a, b) => (dir === 'ascending' ? a - b : b - a)));
    };

    await clickHeader(power);
    await expect(power).toHaveAttribute('aria-sort', 'ascending');
    check(await powers(), 'ascending');
    await expect(table.locator('[aria-sort]:not([aria-sort="none"])')).toHaveCount(1);

    await clickHeader(power);
    await expect(power).toHaveAttribute('aria-sort', 'descending');
    check(await powers(), 'descending');

    const move = table.getByRole('columnheader', { name: /^\s*Move/ });
    await clickHeader(move);
    await expect(move).toHaveAttribute('aria-sort', 'ascending');
    await expect(table.locator('[aria-sort]:not([aria-sort="none"])')).toHaveCount(1);
  });

  test('changing the game updates the URL and the tables', async ({ page }) => {
    await page.goto('/pokemon/pikachu');
    const moves = section(page, 'Moves');
    await moves.getByLabel('Game', { exact: true }).selectOption({ label: 'Scarlet Violet' });
    await expect(page).toHaveURL(/[?&]game=scarlet-violet(&|$|#)/);
    await expect(section(page, 'Moves').getByRole('table')).toHaveCount(2);
    await expect(section(page, 'Moves').getByRole('table', { name: 'Level Up' })).toBeVisible();
    await expect(section(page, 'Moves').getByRole('table', { name: 'Machine' })).toBeVisible();
  });

  test('links point at species pages', async ({ page }) => {
    await page.goto('/pokemon/deoxys');
    const links = section(page, 'Evolution').getByRole('link');
    await expect(links).toHaveText(['Deoxys']);
    expect(await hrefPath(links.first())).toBe('/pokemon/deoxys');
  });
});

test.describe('Pokémon page with live data', () => {
  test('reflects changed values', async ({ page }) => {
    await page.goto('/pokemon/bulbasaur');
    await expect(main(page).getByText('Sprout Pokémon', { exact: true })).toBeVisible();
    await page.goto('/pokemon/pikachu');
    const table = section(page, 'Base stats').getByRole('table');
    const hp = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'HP', exact: true }) });
    await expect(hp.getByRole('cell').first()).toHaveText('37');
    const total = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Total', exact: true }) });
    await expect(total.getByRole('cell').first()).toHaveText('322');
  });

  test('shows a species added after the build', async ({ page }) => {
    await page.goto('/pokemon/benchmon');
    const m = main(page);
    await expect(m.getByRole('heading', { level: 1 })).toHaveText('Benchmon');
    await expect(m.getByText('#1026', { exact: true })).toBeVisible();
    await expect(m.getByText('Benchmark Pokémon', { exact: true })).toBeVisible();
    await expectText(m, /If you can read this, the app is reading live data\./);
    await expect(section(page, 'Evolution').getByRole('link')).toHaveText(['Benchmon']);
    await expect(section(page, 'Abilities').getByRole('link')).toHaveText(['Limber', 'Imposter']);
  });
});
