import { test, expect } from '@playwright/test';
import { main, cards, cardFor, countText, textOf, expectHref } from './helpers.mjs';

const GENERATIONS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'].map((n) => `Generation ${n}`);
const TYPES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy'];

test.describe('Pokémon list', () => {
  test('shows the first page of all species', async ({ page }) => {
    await page.goto('/');
    const m = main(page);
    // 1,025 species plus Benchmon from the live-data overlay.
    await expect(countText(m, 1026)).toBeVisible();
    await expect(cards(m)).toHaveCount(48);
    await expect(m.getByText('Page 1 of 22')).toBeVisible();
    await expect(m.getByRole('link', { name: 'Previous page' })).toHaveCount(0);
    await expect(m.getByRole('link', { name: 'Next page' })).toBeVisible();

    const first = cards(m).first();
    await expect(first).toContainText('#0001');
    await expect(first).toContainText('Bulbasaur');
    await expectHref(first.getByRole('link'), '/pokemon/bulbasaur');
    await expect(first.locator('img').first()).toBeVisible();
    // Types in slot order.
    expect(await textOf(first)).toMatch(/Grass.*Poison/);

    await expect(cards(m).last()).toContainText('#0048');
  });

  test('has labelled search, type and generation controls', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('searchbox', { name: 'Search' })).toBeVisible();

    const type = page.getByLabel('Type', { exact: true });
    const typeOptions = await type.locator('option').allInnerTexts();
    expect(typeOptions[0].trim()).toBe('All types');
    expect(typeOptions.slice(1).map((t) => t.trim()).sort()).toEqual([...TYPES].sort());

    const generation = page.getByLabel('Generation', { exact: true });
    const genOptions = (await generation.locator('option').allInnerTexts()).map((t) => t.trim());
    expect(genOptions).toEqual(['All generations', ...GENERATIONS]);
  });

  test('paginates with Previous and Next links', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    const m = main(page);
    await expect(m.getByText('Page 2 of 22')).toBeVisible();
    await expect(cards(m).first()).toContainText('#0049');
    await expect(cards(m).first()).toContainText('Venomoth');
    await expect(m.getByRole('link', { name: 'Previous page' })).toBeVisible();
  });

  test('last page includes species added after the build', async ({ page }) => {
    await page.goto('/?page=22');
    const m = main(page);
    await expect(m.getByText('Page 22 of 22')).toBeVisible();
    await expect(cards(m)).toHaveCount(18);
    await expect(m.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    const last = cards(m).last();
    await expect(last).toContainText('#1026');
    await expect(last).toContainText('Benchmon');
    await expect(last).toContainText('Normal');
  });

  test('filters by type and generation from the URL', async ({ page }) => {
    await page.goto('/?type=fire&generation=generation-i');
    const m = main(page);
    await expect(countText(m, 12)).toBeVisible();
    await expect(cards(m)).toHaveCount(12);
    await expect(m.getByText('Page 1 of 1')).toBeVisible();
    await expect(m.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    for (const name of ['Charmander', 'Vulpix', 'Flareon', 'Moltres']) {
      await expect(cardFor(m, new RegExp(name))).toHaveCount(1);
    }
    await expect(page.getByLabel('Type', { exact: true }).locator('option:checked')).toHaveText('Fire');
    await expect(page.getByLabel('Generation', { exact: true }).locator('option:checked')).toHaveText('Generation I');
  });

  test('type filter matches either type slot', async ({ page }) => {
    await page.goto('/?type=poison&generation=generation-i');
    await expect(cardFor(main(page), /Bulbasaur/)).toHaveCount(1);
  });

  test('search updates the results while typing', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('searchbox', { name: 'Search' }).pressSequentially('CHAR', { delay: 50 });
    const m = main(page);
    await expect(countText(m, 7)).toBeVisible();
    for (const name of ['Charmander', 'Charmeleon', 'Charizard', 'Chimchar', 'Charjabug', 'Charcadet', 'Pecharunt']) {
      await expect(cardFor(m, new RegExp(name))).toHaveCount(1);
    }
    await expect(page).toHaveURL(/[?&]q=char(&|$)/i);
  });

  test('search matches humanized names', async ({ page }) => {
    await page.goto('/?q=mr%20mime');
    await expect(cardFor(main(page), /Mr Mime/)).toHaveCount(1);
  });

  test('search finds species added after the build', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('searchbox', { name: 'Search' }).pressSequentially('benchm', { delay: 50 });
    await expect(countText(main(page), 1)).toBeVisible();
    await expect(cardFor(main(page), /Benchmon/)).toHaveCount(1);
  });

  test('changing a filter updates the URL and resets to page 1', async ({ page }) => {
    await page.goto('/?page=3');
    await expect(main(page).getByText('Page 3 of 22')).toBeVisible();
    await page.getByLabel('Type', { exact: true }).selectOption({ label: 'Water' });
    await expect(page).toHaveURL(/[?&]type=water(&|$)/);
    await expect(page).not.toHaveURL(/page=3/);
    const m = main(page);
    await expect(countText(m, 154)).toBeVisible();
    await expect(m.getByText(/Page 1 of 4/)).toBeVisible();
    await expect(cards(m).first()).toContainText('Squirtle');
  });

  test('shows a message when nothing matches', async ({ page }) => {
    await page.goto('/?q=zzzz');
    await expect(main(page).getByText('No Pokémon found')).toBeVisible();
    await expect(cards(main(page))).toHaveCount(0);
  });
});
