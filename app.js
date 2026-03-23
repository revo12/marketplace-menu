import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://juqibbkgfcefroggwbjb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_gOmRcvLoj3VBaraUnRcBhw_frmRiGl6';

const GLIST_URL = 'https://gist.githubusercontent.com/revo12/2a9c956f1d3ff3c9af769dc5d532e339/raw/8dd5c3ef679092216bb3b9ddfab2926dc6bd2e85/itemid';
const FAVORITES_STORAGE_KEY = 'marketplace_menu_favorites';
const FUNCTION_NAME = 'rapid-function';

const READ_BATCH_SIZE = 50;
const PARSE_CONCURRENCY = 3;

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const state = {
  activeTab: 'favorites',
  search: '',
  items: [],
  itemsMap: new Map(),
  favorites: new Set(loadFavorites()),
  parseRunning: false,
  categoryByItemId: {},
  stats: {
    total: 0,
    processed: 0,
    fromDb: 0,
    parsed: 0,
    saved: 0,
    errors: 0
  }
};

const els = {
  tabs: Array.from(document.querySelectorAll('.tab')),
  searchInput: document.getElementById('searchInput'),
  refreshButton: document.getElementById('refreshButton'),
  statusBar: document.getElementById('statusBar'),
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
  await fullRestart();
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      updateTabs();
      render();
    });
  });

  if (els.searchInput) {
    els.searchInput.addEventListener('input', (e) => {
      state.search = e.target.value.trim().toLowerCase();
      render();
    });
  }

  if (els.refreshButton) {
    els.refreshButton.addEventListener('click', async () => {
      await fullRestart();
    });
  }
}

async function fullRestart() {
  state.items = [];
  state.itemsMap = new Map();
  state.categoryByItemId = {};
  state.stats = {
    total: 0,
    processed: 0,
    fromDb: 0,
    parsed: 0,
    saved: 0,
    errors: 0
  };

  setStatus('Загрузка...');
  render();

  await buildFromGlist();
}

async function buildFromGlist() {
  if (state.parseRunning) return;
  state.parseRunning = true;

  try {
    setStatus('Загрузка glist...');
    const response = await fetch(GLIST_URL);

    if (!response.ok) {
      throw new Error(`glist HTTP ${response.status}`);
    }

    const raw = await response.json();
    const queue = normalizeGlistToQueue(raw);

    state.stats.total = queue.length;

    queue.forEach((item) => addOrUpdateItem(item));
    render();

    setStatus(`glist загружен. Элементов: ${queue.length}. Загрузка базы...`);

    const dbMap = await preloadSupabaseRows(queue.map((x) => x.itemId));
    hydrateFromDb(dbMap);

    render();
    setStatus(`База подгружена. Поиск отсутствующих названий...`);

    const parseQueue = state.items.filter((item) => !item.name || !item.name.trim());
    await processWithConcurrency(parseQueue, PARSE_CONCURRENCY, async (item) => {
      await enrichSingleItem(item.itemId);
    });

    setStatus(
      `Готово. Всего: ${state.stats.total} | из базы: ${state.stats.fromDb} | спарсено: ${state.stats.parsed} | сохранено: ${state.stats.saved} | ошибок: ${state.stats.errors}`
    );
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`);
  } finally {
    state.parseRunning = false;
    render();
  }
}

function normalizeGlistToQueue(raw) {
  const map = new Map();

  Object.keys(raw || {}).forEach((groupName) => {
    const ids = Array.isArray(raw[groupName]) ? raw[groupName] : [];

    ids.forEach((itemId) => {
      const id = Number(itemId);
      if (Number.isNaN(id)) return;

      state.categoryByItemId[id] = groupName;

      if (!map.has(id)) {
        map.set(id, {
          itemId: id,
          category: groupName,
          name: '',
          price: 1,
          image: buildDefaultImage(id),
          updatedAt: 0,
          statusText: 'Ожидание',
          parseError: '',
          debugReason: ''
        });
      }
    });
  });

  return Array.from(map.values()).sort((a, b) => a.itemId - b.itemId);
}

async function preloadSupabaseRows(itemIds) {
  const result = new Map();

  for (let i = 0; i < itemIds.length; i += READ_BATCH_SIZE) {
    const batchIds = itemIds.slice(i, i + READ_BATCH_SIZE);

    const { data, error } = await supabase
      .from('items_catalog')
      .select('item_id, category, name, price, updated_at')
      .in('item_id', batchIds);

    if (error) {
      continue;
    }

    for (const row of data || []) {
      result.set(Number(row.item_id), row);
    }
  }

  return result;
}

function hydrateFromDb(dbMap) {
  for (const item of state.items) {
    const row = dbMap.get(item.itemId);
    if (!row) continue;

    item.category = row.category || item.category;
    item.name = row.name || item.name;
    item.price = normalizePrice(row.price, 1);
    item.updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : item.updatedAt;
    item.statusText = 'Из базы';
    item.parseError = '';
    item.debugReason = '';

    state.stats.fromDb++;
  }
}

async function enrichSingleItem(itemId) {
  const item = state.itemsMap.get(itemId);
  if (!item) return;

  try {
    item.statusText = 'Парсинг';
    item.parseError = '';
    item.debugReason = '';
    renderLight();

    const resolvedName = await resolveNameForItem(item);

    if (!resolvedName) {
      item.name = '';
      item.statusText = 'Не найдено';
      item.parseError = item.parseError || 'Название не найдено';
      state.stats.errors++;
      state.stats.processed++;
      renderLight();
      return;
    }

    item.name = resolvedName;
    item.price = normalizePrice(item.price, 1);
    item.updatedAt = Date.now();
    item.statusText = 'Сохранение';
    item.parseError = '';
    state.stats.parsed++;
    renderLight();

    await saveItemToSupabase(item);

    item.statusText = 'Готово';
    state.stats.saved++;
    state.stats.processed++;
    renderLight();
  } catch (error) {
    item.statusText = 'Ошибка';
    item.parseError = error.message;
    state.stats.errors++;
    state.stats.processed++;
    renderLight();
  }
}

async function resolveNameForItem(item) {
  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body: {
      itemId: item.itemId,
      category: item.category
    }
  });

  if (error) {
    throw new Error(`Edge Function: ${error.message}`);
  }

  item.debugReason = data?.reason || '';

  if (data?.ok && data?.name) {
    return data.name;
  }

  item.parseError = data?.reason || 'Название не найдено';
  return '';
}

async function saveItemToSupabase(item) {
  const payload = {
    item_id: item.itemId,
    category: item.category,
    name: item.name,
    price: normalizePrice(item.price, 1),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('items_catalog')
    .upsert([payload], { onConflict: 'item_id' });

  if (error) {
    throw new Error(formatSupabaseError(error));
  }
}

function formatSupabaseError(error) {
  const parts = [
    error?.message || '',
    error?.details || '',
    error?.hint || '',
    error?.code || ''
  ].filter(Boolean);

  return parts.join(' | ');
}

function addOrUpdateItem(item) {
  const existing = state.itemsMap.get(item.itemId);

  if (existing) {
    Object.assign(existing, item);
  } else {
    state.items.push(item);
    state.itemsMap.set(item.itemId, item);
  }

  state.items.sort((a, b) => a.itemId - b.itemId);
}

async function processWithConcurrency(items, limit, worker) {
  let index = 0;

  async function runOne() {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];

      setStatus(
        `Обработка: ${Math.min(state.stats.processed + state.stats.fromDb + 1, state.stats.total)}/${state.stats.total}`
      );

      await worker(item);
    }
  }

  const runners = [];
  for (let i = 0; i < limit; i++) {
    runners.push(runOne());
  }

  await Promise.all(runners);
}

function normalizePrice(price, fallback = 1) {
  if (price === '' || price === null || price === undefined) {
    return fallback;
  }

  const num = Number(price);
  return Number.isNaN(num) ? fallback : num;
}

function buildDefaultImage(itemId) {
  return `https://cdn-eu.majestic-files.net/public/master/static/img/inventory/items/${itemId}.webp`;
}

function buildPlaceholderImage(itemId) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
      <rect width="100%" height="100%" rx="12" ry="12" fill="#1d2430"/>
      <text x="50%" y="46%" text-anchor="middle" dominant-baseline="middle" fill="#8fa3c7" font-family="Arial" font-size="13">Нет фото</text>
      <text x="50%" y="66%" text-anchor="middle" dominant-baseline="middle" fill="#6e7f9f" font-family="Arial" font-size="12">#${itemId}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function setStatus(text) {
  if (els.statusBar) {
    els.statusBar.textContent = text;
  }
}

function updateTabs() {
  els.tabs.forEach((tab) => {
    tab.classList.toggle('tab--active', tab.dataset.tab === state.activeTab);
  });

  if (els.favoritesView) {
    els.favoritesView.classList.toggle('view--active', state.activeTab === 'favorites');
  }

  if (els.libraryView) {
    els.libraryView.classList.toggle('view--active', state.activeTab === 'library');
  }
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem(
    FAVORITES_STORAGE_KEY,
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
  const searchValue = state.search || '';

  const bySearch = state.items.filter((item) => {
    const itemName = (item.name || '').toLowerCase();
    return itemName.includes(searchValue) || String(item.itemId).includes(searchValue);
  });

  if (state.activeTab === 'favorites') {
    return bySearch.filter((item) => state.favorites.has(item.itemId));
  }

  return bySearch;
}

function render() {
  updateTabs();

  const items = getFilteredItems();

  if (state.activeTab === 'favorites') {
    renderGrid(els.favoritesGrid, items);
    if (els.favoritesEmpty) {
      els.favoritesEmpty.style.display = items.length ? 'none' : 'block';
    }
  } else {
    renderGrid(els.libraryGrid, items);
    if (els.libraryEmpty) {
      els.libraryEmpty.style.display = items.length ? 'none' : 'block';
    }
  }
}

let lightRenderQueued = false;
function renderLight() {
  if (lightRenderQueued) return;
  lightRenderQueued = true;

  requestAnimationFrame(() => {
    lightRenderQueued = false;
    render();
  });
}

function renderGrid(container, items) {
  if (!container) return;

  container.innerHTML = items.map((item) => {
    const active = state.favorites.has(item.itemId);
    const itemName = item.name || `Предмет #${item.itemId}`;
    const fallbackImage = buildPlaceholderImage(item.itemId);
    const priceText = formatPrice(item.price);

    const shortReason = item.parseError ? item.parseError.slice(0, 80) : '';

    const titleParts = [
      itemName,
      item.statusText || '',
      item.parseError || '',
      item.debugReason || ''
    ].filter(Boolean);

    const cardTitle = titleParts.join(' | ');

    return `
      <div class="item-card" title="${escapeHtml(cardTitle)}">
        <div class="item-card__price">${escapeHtml(priceText)}</div>

        <button
          class="item-card__favorite ${active ? 'item-card__favorite--active' : ''}"
          data-favorite-id="${item.itemId}"
          title="Добавить в избраное"
        >★</button>

        <div class="item-card__image-wrap">
          <img
            class="item-card__image"
            src="${escapeHtml(item.image)}"
            alt="${escapeHtml(itemName)}"
            loading="lazy"
            onerror="this.onerror=null;this.src='${escapeHtml(fallbackImage)}';"
          />
        </div>

        <div class="item-card__body">
          <div class="item-card__name">${escapeHtml(itemName)}</div>
          <div class="item-card__meta">${escapeHtml(item.statusText || '')}</div>
          ${shortReason ? `<div class="item-card__error">${escapeHtml(shortReason)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-favorite-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemId = Number(button.dataset.favoriteId);
      toggleFavorite(itemId);
    });
  });
}

function formatPrice(price) {
  const num = Number(price);
  if (Number.isNaN(num)) return '1$';
  return `${num.toLocaleString('ru-RU')}$`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
