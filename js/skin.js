// Visual themes ("skins"). Each one is a stylesheet in themes/ layered over styles.css.
// A variant id "base--variant" loads themes/base.css; its own rules hang off :root[data-skin="base--variant"].
// index.html applies the saved skin before first paint; this module drives the picker.

export const SKINS = [
  { id: 'construction', name: 'Construction' },
  { id: 'torn', name: 'Torn paper' },
  // Calendar ideas for Torn paper, to compare side by side.
  { id: 'torn--journal', name: 'Torn paper · bullet journal' },
  { id: 'torn--planner', name: 'Torn paper · planner' },
  { id: 'torn--washi', name: 'Torn paper · washi tape' },
];
export const DEFAULT_SKIN = 'construction';
export const SKIN_KEY = 'tb.skin';
export const SKIN_VERSION = 5; // bump when any themes/*.css changes, to bust caches

export function normalizeSkin(id) {
  return SKINS.some((s) => s.id === id) ? id : DEFAULT_SKIN;
}

export const skinFile = (id) => id.split('--')[0];

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
    for (const el of inline) el.media = el.dataset.skin === skinFile(skin) ? 'all' : 'not all';
    syncThemeColor();
  } else {
    const link = document.getElementById('skin');
    const href = `themes/${skinFile(skin)}.css?v=${SKIN_VERSION}`;
    if (link && link.getAttribute('href') !== href) {
      link.addEventListener('load', syncThemeColor, { once: true });
      link.setAttribute('href', href);
    } else {
      syncThemeColor();
    }
  }
  document.documentElement.dataset.skin = skin;
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
