// One observer decides which video is playing anywhere in the app. Without
// this, a scrolled feed happily downloads six videos at once — the last thing
// you want on the kind of connection this app is usually used over.

let muted = localStorage.getItem('loop:muted') !== 'false';
const videos = new Set();

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const video = entry.target;
    if (entry.intersectionRatio > 0.6) {
      video.muted = muted;
      video.play().catch(() => { /* autoplay blocked until first tap */ });
    } else {
      video.pause();
    }
  }
}, { threshold: [0, 0.6, 1] });

export function registerVideo(video) {
  video.muted = muted;
  videos.add(video);
  observer.observe(video);
  video.addEventListener('loadedmetadata', () => { video.muted = muted; }, { once: true });
}

export function releaseVideo(video) {
  observer.unobserve(video);
  videos.delete(video);
  video.pause();
  video.removeAttribute('src');
  video.load();
}

export function isMuted() {
  return muted;
}

export function toggleMuted() {
  muted = !muted;
  localStorage.setItem('loop:muted', String(muted));
  videos.forEach((video) => { video.muted = muted; });
  document.dispatchEvent(new CustomEvent('loop:mute', { detail: muted }));
  return muted;
}

export function pauseAll() {
  videos.forEach((video) => video.pause());
}

/** Drop videos whose view has been torn down. The observer holds strong
 *  references, so without this a long session leaks every video ever scrolled. */
export function releaseDetached() {
  for (const video of videos) {
    if (!video.isConnected) releaseVideo(video);
  }
}
