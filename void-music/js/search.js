import { searchCatalog } from './catalog.js';
import { renderCard, renderListItem } from './views.js';
import {
  escapeHtml, getRecentSearches, addRecentSearch, removeRecentSearch, clearRecentSearches,
} from './store.js';
import { DEFAULT_ART } from './constants.js';

const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const searchRecent = document.getElementById('search-recent');
const searchResults = document.getElementById('search-results');
const recentList = document.getElementById('recent-list');
const resultsSongs = document.getElementById('results-songs');
const resultsArtists = document.getElementById('results-artists');

let searchDebounce;
let searchToken = 0;

function renderRecent() {
  const recent = getRecentSearches();
  recentList.innerHTML = recent.length
    ? recent.map((r) => `
      <div class="recent-item" data-query="${escapeHtml(r.query)}">
        <div class="recent-art">
          <img src="${escapeHtml(r.artwork || DEFAULT_ART)}" alt=""
               onerror="this.onerror=null;this.src='${DEFAULT_ART}'">
        </div>
        <div class="recent-info">
          <p class="recent-title">${escapeHtml(r.query)}</p>
          <p class="recent-sub">${escapeHtml(r.type || 'Search')}</p>
        </div>
        <button class="recent-remove" data-remove="${escapeHtml(r.query)}" aria-label="Remove">×</button>
      </div>
    `).join('')
    : '<p style="color:var(--text-muted); font-size:13px; padding:8px 0;">No recent searches yet.</p>';
}

function showRecent() {
  searchRecent.classList.remove('hidden');
  searchResults.classList.add('hidden');
  renderRecent();
}

function showResults() {
  searchRecent.classList.add('hidden');
  searchResults.classList.remove('hidden');
}

export async function performSearch(query) {
  const q = query.trim();
  if (!q) { showRecent(); return; }

  showResults();
  const token = ++searchToken;
  resultsSongs.innerHTML = '<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>';
  resultsArtists.innerHTML = '';

  let result;
  try {
    result = await searchCatalog(q, 15);
  } catch {
    if (token !== searchToken) return;
    resultsSongs.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">Search failed. Try again.</p>';
    return;
  }
  if (token !== searchToken) return; // a newer keystroke superseded this search

  const { songs, artists } = result;

  resultsSongs.innerHTML = songs.length
    ? songs.map((s) => renderListItem(s, null)).join('')
    : '<p style="color:var(--text-muted); font-size:13px;">No songs found.</p>';

  resultsArtists.innerHTML = artists.length
    ? artists.map((a) => `
      <button class="artist-chip" data-artist="${escapeHtml(a.name)}">
        <img src="${escapeHtml(a.image || DEFAULT_ART)}" alt=""
             onerror="this.onerror=null;this.src='${DEFAULT_ART}'">
        <span>${escapeHtml(a.name)}</span>
      </button>
    `).join('')
    : '';

  addRecentSearch({ query: q, type: 'Search', artwork: songs[0]?.artwork || '' });
}

searchInput.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  searchClear.classList.toggle('hidden', !q);

  clearTimeout(searchDebounce);
  if (!q) { showRecent(); return; }
  searchDebounce = setTimeout(() => performSearch(q), 300);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchDebounce); performSearch(searchInput.value); }
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.classList.add('hidden');
  showRecent();
  searchInput.focus();
});

document.getElementById('search-recent-clear').addEventListener('click', () => {
  clearRecentSearches();
  renderRecent();
});

recentList.addEventListener('click', (e) => {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    removeRecentSearch(remove.dataset.remove);
    renderRecent();
    return;
  }
  const item = e.target.closest('[data-query]');
  if (item) {
    searchInput.value = item.dataset.query;
    searchClear.classList.remove('hidden');
    performSearch(item.dataset.query);
  }
});

resultsArtists.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-artist]');
  if (!chip) return;
  searchInput.value = chip.dataset.artist;
  searchClear.classList.remove('hidden');
  performSearch(chip.dataset.artist);
});

export function loadSearchView() {
  if (!searchInput.value.trim()) showRecent();
}
