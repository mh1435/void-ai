import { getHomeCatalog } from './catalog.js';
import * as player from './player.js';
import { isConfigured as jamendoConfigured } from './jamendo.js';
import {
  escapeHtml, registerTrack, getTrack,
  getRecentlyPlayed, getLiked,
  localStorageFootprintBytes, getRecentSearches, clearAllLocalData,
} from './store.js';
import { toast } from './toast.js';
import { DEFAULT_ART } from './constants.js';

// -- markup builders ---------------------------------------------------------

export function renderCard(item) {
  registerTrack(item);
  const badge = item.flac ? '<span class="card-badge">FLAC</span>' : '';
  return `
    <button class="card" data-id="${escapeHtml(item.id)}" data-kind="${escapeHtml(item.kind || 'track')}">
      <div class="card-art">
        <img src="${escapeHtml(item.artwork || DEFAULT_ART)}" alt="" loading="lazy"
             onerror="this.onerror=null;this.src='${DEFAULT_ART}'">
        ${badge}
      </div>
      <p class="card-title">${escapeHtml(item.title)}</p>
      <p class="card-meta">${escapeHtml(item.artist || '')}</p>
    </button>
  `;
}

export function renderListItem(item, index) {
  registerTrack(item);
  const rank = index != null ? `<span class="list-rank">${index + 1}</span>` : '';
  return `
    <button class="list-item" data-id="${escapeHtml(item.id)}" data-kind="${escapeHtml(item.kind || 'track')}">
      ${rank}
      <div class="list-art">
        <img src="${escapeHtml(item.artwork || DEFAULT_ART)}" alt="" loading="lazy"
             onerror="this.onerror=null;this.src='${DEFAULT_ART}'">
      </div>
      <div class="list-info">
        <p class="list-title">${escapeHtml(item.title)}</p>
        <p class="list-artist">${escapeHtml(item.artist || '')}</p>
      </div>
    </button>
  `;
}

function renderSkeletonCards(n) {
  return Array.from({ length: n }, () => '<div class="skeleton skeleton-card"></div>').join('');
}

function renderSkeletonRows(n) {
  return Array.from({ length: n }, () => '<div class="skeleton skeleton-row"></div>').join('');
}

function emptyState(icon, title, sub) {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <p><strong>${escapeHtml(title)}</strong></p>
      ${sub ? `<p>${escapeHtml(sub)}</p>` : ''}
    </div>
  `;
}

// -- click delegation: any rendered card/list-item plays via this ----------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-id][data-kind]');
  if (!el) return;
  const id = el.dataset.id;
  const kind = el.dataset.kind;

  if (kind !== 'track') {
    toast('Browsing albums and playlists isn’t wired up yet — try a song.');
    return;
  }

  const track = getTrack(id);
  if (!track) { toast('That track is no longer available.'); return; }
  player.playTrack(track);
});

// Category pill groups: click toggles `.active` among siblings.
document.addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  const group = pill.closest('.category-pills');
  if (!group) return;
  group.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
  pill.classList.add('active');
});

// "See all" buttons on Home jump to Library via the same nav wiring as the
// bottom nav (app.js listens for this custom event).
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-nav]');
  if (!el) return;
  window.dispatchEvent(new CustomEvent('nav:go', { detail: el.dataset.nav }));
});

// -- Home ---------------------------------------------------------------

export async function loadHome() {
  const newReleasesEl = document.getElementById('new-releases');
  const playlistsEl = document.getElementById('playlists');
  const topAlbumsEl = document.getElementById('top-albums');
  const heroImg = document.getElementById('hero-img');
  const heroMeta = document.getElementById('hero-meta');
  const heroPlay = document.getElementById('hero-play');

  newReleasesEl.innerHTML = renderSkeletonCards(3);
  playlistsEl.innerHTML = renderSkeletonCards(2);
  topAlbumsEl.innerHTML = renderSkeletonRows(3);

  let catalog;
  try {
    catalog = await getHomeCatalog();
  } catch {
    newReleasesEl.innerHTML = emptyState('⚠', 'Couldn’t load the catalog', 'Check your connection and try again.');
    playlistsEl.innerHTML = '';
    topAlbumsEl.innerHTML = '';
    return;
  }

  const { newReleases, playlists, topAlbums, jamendoConfigured: hasJamendo } = catalog;

  // Hero: the first new release becomes "Daily Mix".
  const heroTrack = newReleases[0];
  if (heroTrack) {
    heroImg.src = heroTrack.artwork || DEFAULT_ART;
    heroImg.onerror = () => { heroImg.onerror = null; heroImg.src = DEFAULT_ART; };
    heroMeta.textContent = `${newReleases.length} tracks · updated today`;
    heroPlay.onclick = () => player.playTrack(heroTrack, newReleases);
  } else {
    heroMeta.textContent = 'No tracks available right now.';
    heroPlay.onclick = () => toast('Nothing to play yet.');
  }

  newReleasesEl.innerHTML = newReleases.length
    ? newReleases.slice(0, 12).map(renderCard).join('')
    : emptyState('🎵', 'No new releases found', 'Try again in a moment.');

  playlistsEl.innerHTML = playlists.length
    ? playlists.map(renderCard).join('')
    : emptyState('📁', hasJamendo ? 'No playlists found' : 'Add a Jamendo key for playlists', 'Settings → Audio & Catalog');

  topAlbumsEl.innerHTML = topAlbums.length
    ? topAlbums.map((a, i) => renderListItem(a, i)).join('')
    : emptyState('💿', hasJamendo ? 'No albums found' : 'Add a Jamendo key for albums', 'Settings → Audio & Catalog');
}

document.getElementById('hero-add').addEventListener('click', () => {
  toast('Saved to Liked — open Library to see it.');
});

// -- Library --------------------------------------------------------------

export function loadLibrary() {
  const content = document.getElementById('library-content');
  const activeKind = document.querySelector('#view-library .pill.active')?.dataset.kind || 'recent';
  render(activeKind);

  function render(kind) {
    const list = kind === 'liked' ? getLiked() : getRecentlyPlayed();
    content.innerHTML = list.length
      ? list.map((t, i) => renderListItem(t, i)).join('')
      : emptyState(
        kind === 'liked' ? '♥' : '🕒',
        kind === 'liked' ? 'No liked songs yet' : 'Nothing played yet',
        kind === 'liked' ? 'Tap the heart on a track to save it here.' : 'Play something from Home or Search.',
      );
  }

  document.querySelectorAll('#view-library [data-kind]').forEach((pill) => {
    pill.onclick = () => render(pill.dataset.kind);
  });

  document.getElementById('library-refresh').onclick = () => render(
    document.querySelector('#view-library .pill.active')?.dataset.kind || 'recent',
  );
}

// -- Sync -------------------------------------------------------------------

export function loadSync() {
  document.getElementById('sync-tracks').textContent = String(getRecentlyPlayed().length);
  document.getElementById('sync-liked').textContent = String(getLiked().length);
  document.getElementById('sync-searches').textContent = String(getRecentSearches().length);
  const kb = Math.max(1, Math.round(localStorageFootprintBytes() / 1024));
  document.getElementById('sync-storage').textContent = `${kb} KB`;

  const last = localStorage.getItem('void:lastSync');
  document.getElementById('sync-time').textContent = last
    ? `Last sync ${new Date(Number(last)).toLocaleString()}`
    : 'Never synced';

  const hasJamendo = jamendoConfigured();
  document.getElementById('sync-source-status').textContent = hasJamendo
    ? 'Internet Archive + Jamendo'
    : 'Internet Archive only';
  document.getElementById('jamendo-badge').textContent = hasJamendo ? 'Connected' : 'Not connected';
  document.getElementById('jamendo-badge').classList.toggle('connected', hasJamendo);
  document.getElementById('jamendo-stats').textContent = hasJamendo
    ? 'API key set on this device'
    : 'No API key set';

  document.getElementById('sync-refresh').onclick = async () => {
    localStorage.setItem('void:lastSync', String(Date.now()));
    toast('Refreshing catalog…');
    await loadHome();
    loadSync();
    toast('Streaming index updated.');
  };

  document.querySelectorAll('.segmented-control').forEach((seg) => {
    seg.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => {
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      };
    });
  });
}

// -- Settings ---------------------------------------------------------------

export function loadSettingsView() {
  const kb = Math.max(1, Math.round(localStorageFootprintBytes() / 1024));
  document.getElementById('settings-storage-line').textContent =
    `${getRecentlyPlayed().length} tracks · ${kb} KB`;
}

document.getElementById('settings-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('[data-settings-row]').forEach((row) => {
    const match = !q || row.textContent.toLowerCase().includes(q);
    row.classList.toggle('hidden', !match);
  });
});

document.getElementById('settings-reset').addEventListener('click', () => {
  if (!confirm('Clear recently played, liked songs and search history on this device?')) return;
  clearAllLocalData();
  toast('Local data cleared.');
  loadSettingsView();
});
