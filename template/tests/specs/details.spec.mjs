import { test, expect } from '@playwright/test';
import { main, section, cards, cardFor, countText, expectText, expectHref } from './helpers.mjs';

const TYPES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy'];

test.describe('Move page', () => {
  test('shows the move details', async ({ page }) => {
    await page.goto('/moves/thunderbolt');
    const m = main(page);
    await expect(m.getByRole('heading', { level: 1 })).toHaveText('Thunderbolt');
    await expectHref(m.getByRole('link', { name: 'Electric', exact: true }), '/types/electric');
    await expectText(m, /Type Electric/);
    await expectText(m, /Category Special/);
    // 95 in the live-data overlay (90 at build time).
    await expectText(m, /Power 95/);
    await expectText(m, /Accuracy 100/);
    await expectText(m, /PP 15/);
    await expect(section(page, 'Effect')).toContainText('Has a chance to paralyze the target.');
  });

  test('lists the Pokémon that learn it', async ({ page }) => {
    await page.goto('/moves/thunderbolt');
    const learnedBy = section(page, 'Learned by');
    await expect(countText(learnedBy, 256)).toBeVisible();
    await expect(cards(learnedBy)).toHaveCount(256);
    const first = cards(learnedBy).first();
    await expect(first).toContainText('#0019');
    await expect(first).toContainText('Rattata');
    await expectHref(first.getByRole('link'), '/pokemon/rattata');
  });

  test('maps Pokémon to their species and leaves out alternate forms', async ({ page }) => {
    await page.goto('/moves/psycho-boost');
    const learnedBy = section(page, 'Learned by');
    await expect(countText(learnedBy, 2)).toBeVisible();
    await expect(cards(learnedBy)).toHaveCount(2);
    const deoxys = cards(learnedBy).last();
    await expect(deoxys).toContainText('#0386');
    await expect(deoxys).toContainText('Deoxys');
    await expect(deoxys).not.toContainText('Normal');
    await expectHref(deoxys.getByRole('link'), '/pokemon/deoxys');
  });

  test('falls back to flavor text when there is no effect text', async ({ page }) => {
    await page.goto('/moves/dire-claw');
    await expect(section(page, 'Effect')).toContainText(
      'The user lashes out at the target with ruinous claws. This may also leave the target poisoned, paralyzed, or asleep.',
    );
  });

  test('shows a missing power as an em dash', async ({ page }) => {
    await page.goto('/moves/growl');
    await expectText(main(page), /Power —/);
  });

  test('includes Pokémon added after the build', async ({ page }) => {
    await page.goto('/moves/transform');
    await expect(cardFor(section(page, 'Learned by'), /Benchmon/)).toHaveCount(1);
  });
});

test.describe('Ability page', () => {
  test('shows the effect and the Pokémon with the ability', async ({ page }) => {
    await page.goto('/abilities/static');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Static');
    await expect(section(page, 'Effect')).toContainText('Has a 30% chance of paralyzing attacking Pokémon on contact.');
    const pokemon = section(page, 'Pokémon');
    await expect(countText(pokemon, 20)).toBeVisible();
    await expect(cards(pokemon)).toHaveCount(20);
    await expect(cards(pokemon).first()).toContainText('Pikachu');
    await expect(cardFor(pokemon, /Pikachu/)).not.toContainText('Hidden ability');
  });

  test('marks hidden abilities', async ({ page }) => {
    await page.goto('/abilities/imposter');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Imposter');
    const pokemon = section(page, 'Pokémon');
    await expect(cardFor(pokemon, /Ditto/)).toContainText('Hidden ability');
    await expect(cardFor(pokemon, /Benchmon/)).toContainText('Hidden ability');
  });

  test('uses the English name for the heading', async ({ page }) => {
    await page.goto('/abilities/lightning-rod');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Lightning Rod');
  });

  test('includes Pokémon added after the build', async ({ page }) => {
    await page.goto('/abilities/limber');
    await expect(cardFor(section(page, 'Pokémon'), /Benchmon/)).not.toContainText('Hidden ability');
  });
});

test.describe('Type list', () => {
  test('links to the 18 types in order', async ({ page }) => {
    await page.goto('/types');
    const links = main(page).getByRole('listitem').getByRole('link');
    await expect(links).toHaveText(TYPES);
    await expectHref(links.first(), '/types/normal');
    await expectHref(links.last(), '/types/fairy');
  });
});

test.describe('Type page', () => {
  test('shows damage relations', async ({ page }) => {
    await page.goto('/types/fire');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Fire');
    const relations = section(page, 'Damage relations');
    await expect(relations.getByRole('term')).toHaveText([
      'Super effective against', 'Not very effective against', 'No effect against', 'Weak to', 'Resists', 'Immune to',
    ]);
    const expected = [
      ['Bug', 'Grass', 'Ice', 'Steel'],
      ['Dragon', 'Fire', 'Rock', 'Water'],
      [],
      ['Ground', 'Rock', 'Water'],
      ['Bug', 'Fairy', 'Fire', 'Grass', 'Ice', 'Steel'],
      [],
    ];
    const definitions = relations.getByRole('definition');
    await expect(definitions).toHaveCount(6);
    for (const [i, types] of expected.entries()) {
      const links = definitions.nth(i).getByRole('link');
      expect((await links.allInnerTexts()).map((t) => t.trim()).sort()).toEqual(types);
      if (!types.length) await expect(definitions.nth(i)).toHaveText(/^\s*None\s*$/);
    }
    await expectHref(definitions.nth(0).getByRole('link', { name: 'Grass' }), '/types/grass');
  });

  test('lists Pokémon and moves of the type', async ({ page }) => {
    await page.goto('/types/fire');
    const pokemon = section(page, 'Pokémon');
    await expect(countText(pokemon, 81)).toBeVisible();
    await expect(cards(pokemon)).toHaveCount(81);
    await expect(cards(pokemon).first()).toContainText('Charmander');

    const moves = section(page, 'Moves');
    await expect(countText(moves, 47, 'moves')).toBeVisible();
    const links = moves.getByRole('link');
    await expect(links).toHaveCount(47);
    await expect(links.first()).toHaveText('Armor Cannon');
    await expectHref(links.first(), '/moves/armor-cannon');
    const names = (await links.allInnerTexts()).map((t) => t.trim());
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test('cards link to species pages', async ({ page }) => {
    await page.goto('/types/psychic');
    const deoxys = cardFor(section(page, 'Pokémon'), /Deoxys/);
    await expect(deoxys).toHaveCount(1);
    await expectHref(deoxys.getByRole('link'), '/pokemon/deoxys');
  });

  test('includes Pokémon added after the build', async ({ page }) => {
    await page.goto('/types/normal');
    await expect(cardFor(section(page, 'Pokémon'), /Benchmon/)).toHaveCount(1);
  });
});

test.describe('Not found', () => {
  for (const url of ['/pokemon/missingno', '/moves/not-a-move', '/abilities/not-an-ability', '/types/not-a-type', '/no/such/page']) {
    test(`${url} shows a not-found page`, async ({ page }) => {
      await page.goto(url);
      await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Not found');
      await expect(page).toHaveTitle('Not found – Pokédex');
      const links = main(page).getByRole('link');
      await expect(links.first()).toBeVisible();
      expect(await Promise.all((await links.all()).map((l) => l.getAttribute('href').then((h) => new URL(h, 'http://x').pathname)))).toContain('/');
    });
  }
});
