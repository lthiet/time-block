// Visual themes ("skins"). Each one is a stylesheet in themes/ layered over styles.css.
// index.html applies the saved skin before first paint; this module drives the picker.
import { setPostit } from './postit.js?v=1';

export const SKINS = [
  { id: 'construction', name: 'Construction' },
  { id: 'torn', name: 'Cut paper' }, // id kept from when it was torn, so saved choices still apply
];
export const DEFAULT_SKIN = 'construction';
export const SKIN_KEY = 'tb.skin';
export const SKIN_VERSION = 13; // bump when any themes/*.css changes, to bust caches

export function normalizeSkin(id) {
  return SKINS.some((s) => s.id === id) ? id : DEFAULT_SKIN;
}

export function currentSkin() {
  try {
    return normalizeSkin(localStorage.getItem(SKIN_KEY));
  } catch {
    return DEFAULT_SKIN;
  }
}

// Match the browser's theme colour to the skin's top bar once its stylesheet has applied.
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  const bar = getComputedStyle(document.documentElement).getPropertyValue('--bar').trim();
  if (meta && bar && !bar.includes('gradient')) meta.content = bar;
}

export function applySkin(id) {
  const skin = normalizeSkin(id);
  const inline = document.querySelectorAll('style[data-skin]');
  if (inline.length) {
    // Single-file preview build: every skin is inlined; enable just one.
    for (const el of inline) el.media = el.dataset.skin === skin ? 'all' : 'not all';
    syncThemeColor();
  } else {
    const link = document.getElementById('skin');
    const href = `themes/${skin}.css?v=${SKIN_VERSION}`;
    if (link && link.getAttribute('href') !== href) {
      link.addEventListener('load', syncThemeColor, { once: true });
      link.setAttribute('href', href);
    } else {
      syncThemeColor();
    }
  }
  document.documentElement.dataset.skin = skin;
  setPostit(skin === 'torn'); // its calendar blocks are post-its with generated outlines
  try {
    localStorage.setItem(SKIN_KEY, skin);
  } catch {}
  return skin;
}

export function initSkinPicker(select) {
  const skin = currentSkin();
  select.replaceChildren(...SKINS.map((s) => new Option(s.name, s.id, false, s.id === skin)));
  select.addEventListener('change', () => applySkin(select.value));
  applySkin(skin);
}
