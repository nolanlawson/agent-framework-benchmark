// Progressive enhancement for the server-rendered pages.

// Home page: live search and filters. Fetch the server-rendered page for the new query
// and swap in its results.
const filters = document.querySelector('[data-live-filters]');
if (filters) {
  let timer;
  let latest = 0;
  const update = async (push) => {
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(filters)) if (String(value).trim()) params.set(key, String(value).trim());
    const target = params.size ? `/?${params}` : '/';
    const request = ++latest;
    const doc = new DOMParser().parseFromString(await (await fetch(target)).text(), 'text/html');
    if (request !== latest) return;
    document.getElementById('results').replaceWith(doc.getElementById('results'));
    history[push ? 'pushState' : 'replaceState'](null, '', target);
  };
  filters.addEventListener('input', (e) => {
    if (e.target.type !== 'search') return;
    clearTimeout(timer);
    timer = setTimeout(() => update(false), 150);
  });
  filters.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT') update(true);
  });
  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    update(true);
  });
  addEventListener('popstate', () => location.reload());
}

// Pokémon page: changing the game reloads the page with ?game=...#moves.
const gameForm = document.querySelector('[data-game-select]');
if (gameForm) {
  gameForm.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('game', gameForm.elements.game.value);
    url.hash = 'moves';
    location.assign(url);
  });
}

// Sortable tables: click a column header to sort; click again to reverse.
for (const table of document.querySelectorAll('table[data-sortable]')) {
  const headers = [...table.tHead.rows[0].cells];
  headers.forEach((th, col) => {
    th.querySelector('button').addEventListener('click', () => {
      const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
      for (const h of headers) h.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', dir);
      const tbody = table.tBodies[0];
      const value = (row) => row.cells[col].dataset.value ?? '';
      const rows = [...tbody.rows].sort((a, b) => {
        const va = value(a), vb = value(b);
        if (va === '' || vb === '') return (va === '') - (vb === '');
        const na = Number(va), nb = Number(vb);
        const cmp = Number.isNaN(na) || Number.isNaN(nb) ? va.localeCompare(vb) : na - nb;
        return dir === 'ascending' ? cmp : -cmp;
      });
      tbody.append(...rows);
    });
  });
}
