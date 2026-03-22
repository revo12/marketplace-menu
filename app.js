const CONFIG = {
  glistUrl: 'https://gist.githubusercontent.com/revo12/2a9c956f1d3ff3c9af769dc5d532e339/raw/8dd5c3ef679092216bb3b9ddfab2926dc6bd2e85/itemid',

  imageUrlById: (itemId) =>
    `https://cdn-eu.majestic-files.net/public/master/static/img/inventory/items/${itemId}.webp`,

  wikiUrlByItem: (wikiSlug, itemId) =>
    `https://wiki.majestic-rp.ru/ru/items/${wikiSlug}/${itemId}`,

  favoritesStorageKey: 'marketplace_menu_favorites',

  groupKeyToWikiSlug: {
    food: 'food',
    tool: 'tools',
    fish: 'fish',
    equipment: 'equipment',
    alcohol: 'alcohol',
    ammunition: 'ammunition',
    medical: 'medicine',
    auto_parts: 'auto-parts',
    misc: 'misc',
    consumables: 'consumables',
    facilities: 'infrastructure',
    documents: 'documents',
    books: 'books',
    personals: 'personal-items',
    products: 'products',
    agriculture: 'agriculture',
    drugs: 'ingredients',
    armor: 'armor',
    others: 'misc'
  }
};

const state = {
  activeTab: 'favorites',
  search: '',
  items: [],
  favorites: new Set(loadFavorites()),
  loadingNames: false
};

const els = {
  tabs: Array.from(document.querySelectorAll('.tab')),
  searchInput: document.getElementById('searchInput'),
  favoritesView: document.getElementById('favoritesView'),
  libraryView: document.getElementById('libraryView'),
  favoritesGrid: document.getElementById('favoritesGrid'),
  libraryGrid: document.getElementById('libraryGrid'),
  favoritesEmpty: document.getElementById('favoritesEmpty'),
  libraryEmpty: document.getElementById('libraryEmpty')
};

init();

async function init() {
  bindEvents();
  await loadItems();
  render();
  resolveAllNamesInBackground();
}

function bindEvents() {
  els.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      updateTabs();
      render();
    });
  });

  els.searchInput.addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  });
}

function updateTabs() {
  els.tabs.forEach(tab => {
    tab.classList.toggle('tab--active', tab.dataset.tab === state.activeTab);
  });

  els.favoritesView.classList.toggle('view--active', state.activeTab === 'favorites');
  els.libraryView.classList.toggle('view--active', state.activeTab === 'library');
}

async function loadItems() {
  try {
    const response = await fetch(CONFIG.glistUrl);
    const raw = await response.json();
    state.items = normalizeGlist(raw);
  } catch (error) {
    console.error('Failed to load glist:', error);
    state.items = [];
  }
}

function normalizeGlist(raw) {
  const resultMap = new Map();

  for (const categoryName of Object.keys(raw || {})) {
    const ids = Array.isArray(raw[categoryName]) ? raw[categoryName] : [];

    ids.forEach((itemId) => {
      const id = Number(itemId);
      if (Number.isNaN(id)) return;

      if (!resultMap.has(id)) {
        const wikiSlug = CONFIG.groupKeyToWikiSlug[categoryName] || 'misc';

        resultMap.set(id, {
          id,
          name: `Item ${id}`,
          price: '',
          category: categoryName,
          wikiSlug,
          wikiUrl: CONFIG.wikiUrlByItem(wikiSlug, id),
          image: CONFIG.imageUrlById(id),
          resolved: false
        });
      }
    });
  }

  return Array.from(resultMap.values()).sort((a, b) => a.id - b.id);
}

async function resolveAllNamesInBackground() {
  if (state.loadingNames) return;
  state.loadingNames = true;

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];

    if (item.resolved) continue;

    try {
      const resolvedName = await resolveItemName(item.wikiUrl);
      if (resolvedName) {
        item.name = resolvedName;
      }
    } catch (error) {
      console.error('Failed to resolve item name:', item.id, error);
    }

    item.resolved = true;

    if (i % 8 === 0 || i === state.items.length - 1) {
      render();
    }
  }

  state.loadingNames = false;
  render();
}

async function resolveItemName(url) {
  const response = await fetch(url);
  const html = await response.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const h1 = doc.querySelector('h1');
  if (h1) {
    const value = normalizeText(h1.textContent);
    if (value) return value;
  }

  const title = doc.querySelector('title');
  if (title) {
    const value = normalizeText(title.textContent)
      .replace(/ · .*$/i, '')
      .replace(/ \| .*$/i, '')
      .trim();

    if (value) return value;
  }

  const spans = Array.from(doc.querySelectorAll('span'));
  const backNode = spans.find(node => normalizeText(node.textContent) === 'Вернуться к списку');

  if (backNode) {
    const next =
      backNode.parentElement?.nextElementSibling ||
      backNode.closest('*')?.nextElementSibling;

    if (next) {
      const value = normalizeText(next.textContent);
      if (value) return value;
    }
  }

  return null;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(CONFIG.favoritesStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem(
    CONFIG.favoritesStorageKey,
    JSON.stringify(Array.from(state.favorites))
  );
}

function toggleFavorite(itemId) {
  if (state.favorites.has(itemId)) {
    state.favorites.delete(itemId);
  } else {
    state.favorites.add(itemId);
  }

  saveFavorites();
  render();
}

function getFilteredItems() {
  const bySearch = state.items.filter(item =>
    item.name.toLowerCase().includes(state.search) ||
    String(item.id).includes(state.search)
  );

  if (state.activeTab === 'favorites') {
    return bySearch.filter(item => state.favorites.has(item.id));
  }

  return bySearch;
}

function render() {
  updateTabs();

  const items = getFilteredItems();

  if (state.activeTab === 'favorites') {
    renderGrid(els.favoritesGrid, items);
    els.favoritesEmpty.style.display = items.length ? 'none' : 'block';
  } else {
    renderGrid(els.libraryGrid, items);
    els.libraryEmpty.style.display = items.length ? 'none' : 'block';
  }
}

function renderGrid(container, items) {
  container.innerHTML = items.map(item => {
    const active = state.favorites.has(item.id);

    return `
      <div class="item-card">
        <div class="item-card__price">${escapeHtml(item.price || '')}</div>

        <button
          class="item-card__favorite ${active ? 'item-card__favorite--active' : ''}"
          data-favorite-id="${item.id}"
          title="Добавить в избраное"
        >★</button>

        <div class="item-card__image-wrap">
          <img
            class="item-card__image"
            src="${escapeHtml(item.image)}"
            alt="${escapeHtml(item.name)}"
            loading="lazy"
          />
        </div>

        <div class="item-card__body">
          <div class="item-card__name">${escapeHtml(item.name)}</div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-favorite-id]').forEach(button => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.favoriteId);
      toggleFavorite(id);
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}