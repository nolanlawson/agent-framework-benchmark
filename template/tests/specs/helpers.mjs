import { expect } from '@playwright/test';

export const main = (page) => page.getByRole('main');

// A section: an element with the region role, named by its heading.
export const section = (page, name) => main(page).getByRole('region', { name, exact: true });

// Visible text with whitespace collapsed, for checks that don't depend on structure.
export async function textOf(locator) {
  return (await locator.innerText()).replace(/\s+/g, ' ').trim();
}

export async function expectText(locator, pattern) {
  await expect.poll(() => textOf(locator)).toMatch(pattern);
}

// Path of a link's href, whether it's written relative or absolute.
export async function hrefPath(link) {
  const href = await link.getAttribute('href');
  return new URL(href, 'http://localhost').pathname;
}

export async function expectHref(link, pathname) {
  await expect.poll(() => hrefPath(link)).toBe(pathname);
}

// Pokémon cards: list items containing a link to a Pokémon page.
export const cards = (scope) =>
  scope.getByRole('listitem').filter({ has: scope.page().locator('a[href*="/pokemon/"]') }).filter({ hasText: /#\d{4}/ });

export const cardFor = (scope, name) => cards(scope).filter({ has: scope.page().getByRole('link', { name }) });

// Exact "<n> Pokémon" / "<n> moves" count text.
export const countText = (scope, n, noun = 'Pokémon') => scope.getByText(new RegExp(`(^|\\s)${n} ${noun}($|\\s)`));

export async function rowCells(row) {
  const texts = await row.getByRole('cell').or(row.getByRole('rowheader')).allInnerTexts();
  return texts.map((t) => t.replace(/\s+/g, ' ').trim());
}

export async function clickHeader(header) {
  const button = header.getByRole('button');
  if (await button.count()) await button.first().click();
  else await header.click();
}
