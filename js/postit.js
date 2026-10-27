// Post-it calendar blocks (Torn paper skin): every block gets its own procedurally generated outline.
// Its edges waver a little, and its bottom edge curls up off the page, unevenly. The outline is a clip-path
// polygon in percentages plus pixels, so it fits whatever size the note is.

// Small seeded PRNG (mulberry32), so a note keeps the same outline each time it's re-rendered.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

const r2 = (n) => Math.round(n * 100) / 100;
// A point as "from the left/top" or "from the right/bottom" in px, offset from a percentage.
const at = (pct, px) => `calc(${r2(pct)}% ${px < 0 ? '-' : '+'} ${r2(Math.abs(px))}px)`;

/**
 * Outline for one note.
 * @param seed     number; same seed, same outline
 * @param wobble   how far (px) an edge may waver inward
 * @param lift     [min, max] px the bottom edge curls up off the page, seen from above
 * @param across   stretches along the top edge
 * @param down     stretches down each side
 * @returns { edge, base, lift } — `edge` is the note's clip-path, `base` the same outline lying
 *   flat (for the shadow left on the page), `lift` how far up (px) the bottom edge reaches at most.
 */
export function noteOutline(seed, { wobble = 1, lift = [3, 8], across = 7, down = 7 } = {}) {
  const rand = rng(seed);
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const dent = () => -rand() * wobble; // edges only ever waver inward, so nothing spills out

  // The whole bottom edge curls up, rarely evenly: each end lifts its own amount, and the middle
  // sags a little or bows up a little between them.
  const liftL = between(lift[0], lift[1]);
  const liftR = between(lift[0], lift[1]);
  const bow = between(-0.25, 0.25) * Math.min(liftL, liftR);
  const liftAt = (x) => liftL + (liftR - liftL) * x + bow * 4 * x * (1 - x); // x: 0 left .. 1 right

  // Points between the corners; the corners themselves are added below. The lift stays within the
  // last stretch of each side, so it never cuts across one of these.
  const along = (n) => Array.from({ length: n - 1 }, (_, i) => ((i + 1) / n) * 100 + between(-3, 3));
  const top = along(across).map((p) => `${at(p, 0)} ${at(0, -dent())}`);
  const right = along(down).map((p) => `${at(100, dent())} ${at(p, 0)}`);
  const left = along(down).map((p) => `${at(0, -dent())} ${at(100 - p, 0)}`);
  const xs = [1, 0.8, 0.6, 0.4, 0.2, 0]; // the lifted bottom, right to left, enough points to curve
  const lifted = xs.map((x) => `${at(x * 100, 0)} ${at(100, -liftAt(x) + (x % 1 ? dent() : 0))}`);
  const flatBottom = along(across).map((p) => `${at(100 - p, 0)} ${at(100, dent())}`);
  const TL = `${at(0, 0)} ${at(0, 0)}`, TR = `${at(100, 0)} ${at(0, 0)}`;
  const BR = `${at(100, 0)} ${at(100, 0)}`, BL = `${at(0, 0)} ${at(100, 0)}`;

  return {
    edge: `polygon(${[TL, ...top, TR, ...right, ...lifted, ...left].join(', ')})`,
    base: `polygon(${[TL, ...top, TR, ...right, BR, ...flatBottom, BL, ...left].join(', ')})`,
    lift: r2(Math.max(liftL, liftR, liftAt(0.5))),
  };
}

const NOTES = '.blk, .allday-chip';

function seedFor(el, i) {
  return hashSeed(el.dataset.ev || el.dataset.rowId || `#${i}`);
}

function sizeFor(el) {
  const h = parseFloat(el.style.height) || 20; // all-day chips have no set height
  const max = Math.min(4, h * 0.08); // a 30-minute block lifts barely 2px
  return { wobble: 0.5, lift: [max * 0.35, max], across: 2, down: 3 };
}

function dress(el, i) {
  const o = noteOutline(seedFor(el, i), sizeFor(el));
  el.style.setProperty('--note-edge', o.edge);
  el.style.setProperty('--note-base', o.base);
  el.style.setProperty('--curl', `${o.lift}px`);
}

let observer = null;

/** Turn the generated outlines on or off; called whenever the skin changes. */
export function setPostit(on) {
  observer?.disconnect();
  observer = null;
  if (!on) return;
  document.querySelectorAll(NOTES).forEach(dress);
  let n = 0;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(NOTES)) dress(node, n++);
        node.querySelectorAll(NOTES).forEach((el) => dress(el, n++));
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
