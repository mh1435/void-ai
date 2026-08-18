/* Update check.
 *
 * A sideloaded app has no store to nag it, so it has to ask. This reads the
 * repository's latest GitHub release and compares it with the running build.
 *
 * Failure is entirely acceptable: a private repo, a blocked host or no network
 * all mean "cannot tell", never an error the user has to deal with. */

export const APP_VERSION = '1.6.0';

const REPO = 'mh1435/void-music';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** Compare dotted versions numerically: 1.10.0 is newer than 1.9.0. */
function isNewer(candidate, current) {
  const a = String(candidate).replace(/^v/, '').split('.').map(Number);
  const b = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Resolves to one of:
 *   { status: 'current' }
 *   { status: 'update', version, url, apk }
 *   { status: 'unknown', reason }
 */
export async function checkForUpdate({ signal } = {}) {
  if (!navigator.onLine) return { status: 'unknown', reason: 'offline' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: ctl.signal,
      headers: { Accept: 'application/vnd.github+json' },
    });
    // 404 is the normal answer for a private repo with no public release.
    if (res.status === 404) return { status: 'unknown', reason: 'no public releases' };
    if (!res.ok) return { status: 'unknown', reason: `HTTP ${res.status}` };

    const data = await res.json();
    const tag = String(data.tag_name || '');
    if (!tag) return { status: 'unknown', reason: 'no tag' };

    if (!isNewer(tag, APP_VERSION)) return { status: 'current' };

    const apk = (data.assets || []).find((a) => /\.apk$/i.test(a.name || ''));
    return {
      status: 'update',
      version: tag,
      url: data.html_url || RELEASES_PAGE,
      apk: apk?.browser_download_url || null,
    };
  } catch (err) {
    return { status: 'unknown', reason: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export { RELEASES_PAGE };
