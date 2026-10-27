// Post-it calendar blocks (Torn paper skin): every block gets its own procedurally generated outline.
// Its edges waver a little, and its bottom corners curl up off the page by different amounts. The outline is a clip-path
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
 * @param curl     [min, max] px a bottom corner may curl up
 * @param across   stretches along the top and bottom edges
 * @param down     stretches down each side
 * @returns { edge, base, curlR, curlL } — `edge` is the note's clip-path, `base` the same outline
 *   with flat corners (for the shadow left on the page), `curlR`/`curlL` the [across, up] px each
 *   bottom corner is lifted by (0 when it lies flat), to place the curl's shading.
 */
export function noteOutline(seed, { wobble = 1, curl = [8, 20], across = 7, down = 7 } = {}) {
  const rand = rng(seed);
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const dent = () => -rand() * wobble; // edges only ever waver inward, so nothing spills out

  // One bottom corner curls a lot, the other a little (sometimes not at all).
  const big = between(curl[0], curl[1]);
  const small = rand() < 0.35 ? 0 : between(curl[0] * 0.2, curl[0] * 0.7);
  const rightBig = rand() < 0.6;
  const cR = rightBig ? big : small;
  const cL = rightBig ? small : big;
  const ratioR = between(0.6, 1.3); // how far up the side the curl reaches, relative to along the bottom
  const ratioL = between(0.6, 1.3);

  // Points between the corners; the corners themselves are added below. The curls stay within the
  // last stretch of each edge, so they never cut across one of these.
  const along = (n) => Array.from({ length: n - 1 }, (_, i) => ((i + 1) / n) * 100 + between(-3, 3));
  const top = along(across).map((p) => `${at(p, 0)} ${at(0, -dent())}`);
  const right = along(down).map((p) => `${at(100, dent())} ${at(p, 0)}`);
  const bottom = along(across).map((p) => `${at(100 - p, 0)} ${at(100, dent())}`);
  const left = along(down).map((p) => `${at(0, -dent())} ${at(100 - p, 0)}`);
  const TL = `${at(0, 0)} ${at(0, 0)}`, TR = `${at(100, 0)} ${at(0, 0)}`;
  const BR = `${at(100, 0)} ${at(100, 0)}`, BL = `${at(0, 0)} ${at(100, 0)}`;

  // A curled corner seen from above: the corner is pulled back along a rounded line.
  function corner(c, ratio, isRight) {
    const pts = [];
    const n = 5;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // Quadratic bezier from the bottom edge to the side, bowed slightly toward the corner
      // (a control point at .5 would be a straight fold).
      const bx = c, by = 0, cx = c * 0.38, cy = c * ratio * 0.38, ex = 0, ey = c * ratio;
      const x = (1 - t) ** 2 * bx + 2 * (1 - t) * t * cx + t ** 2 * ex;
      const y = (1 - t) ** 2 * by + 2 * (1 - t) * t * cy + t ** 2 * ey;
      pts.push(isRight ? `${at(100, -x)} ${at(100, -y)}` : `${at(0, x)} ${at(100, -y)}`);
    }
    return isRight ? pts.reverse() : pts; // clockwise: down the right side, then right to left along the bottom
  }

  const flat = [TL, ...top, TR, ...right, BR, ...bottom, BL, ...left];
  const curled = [
    TL, ...top, TR, ...right,
    ...(cR ? corner(cR, ratioR, true) : [BR]),
    ...bottom,
    ...(cL ? corner(cL, ratioL, false) : [BL]),
    ...left,
  ];
  return {
    edge: `polygon(${curled.join(', ')})`,
    base: `polygon(${flat.join(', ')})`,
    curlR: [r2(cR), r2(cR * ratioR)],
    curlL: [r2(cL), r2(cL * ratioL)],
  };
}

const NOTES = '.blk, .allday-chip';

function seedFor(el, i) {
  return hashSeed(el.dataset.ev || el.dataset.rowId || `#${i}`);
}

function sizeFor(el) {
  const h = parseFloat(el.style.height) || 20; // all-day chips have no set height
  const max = Math.min(8, h * 0.2);
  return { wobble: 0.5, curl: [Math.min(3, max), max], across: 2, down: 3 };
}

function dress(el, i) {
  const o = noteOutline(seedFor(el, i), sizeFor(el));
  el.style.setProperty('--note-edge', o.edge);
  el.style.setProperty('--note-base', o.base);
  // The shading box is twice the fold, so the fold runs across it a quarter of the way in.
  el.style.setProperty('--curl-r', `${o.curlR[0] * 2}px ${o.curlR[1] * 2}px`);
  el.style.setProperty('--curl-l', `${o.curlL[0] * 2}px ${o.curlL[1] * 2}px`);
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
