// Cut paper: each square is cut from paper with scissors and each calendar block is a post-it,
// every one with its own procedurally generated outline. Cut squares have straight edges that change
// angle where the scissors were re-gripped, and now and then a nick where a cut ran past a corner;
// post-its waver a little and their bottom edge curls up off the page, unevenly. The outline is a clip-path
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

/**
 * Outline of a square cut out with scissors: each edge is one or a few straight cuts, set in from
 * the box by a few px and at slightly different angles, and some corners have a short slit where a
 * cut overshot.
 * @param seed   number; same seed, same outline
 * @param inset  [min, max] px each cut sits in from the box
 * @returns a clip-path polygon
 */
export function cutOutline(seed, { inset = [1, 9] } = {}) {
  const rand = rng(seed);
  const between = (lo, hi) => lo + rand() * (hi - lo);
  // A point on a side, `pct`% plus `px` along it clockwise, `depth` px in from the box.
  const pt = (side, pct, px, depth) => [
    () => `${at(pct, px)} ${at(0, depth)}`,
    () => `${at(100, -depth)} ${at(pct, px)}`,
    () => `${at(100 - pct, -px)} ${at(100, -depth)}`,
    () => `${at(0, depth)} ${at(100 - pct, -px)}`,
  ][side]();

  const edges = [0, 1, 2, 3].map(() => ({
    start: between(...inset),
    end: between(...inset),
    // Where the scissors were re-gripped: the cut changes angle a little.
    kinks: Array.from({ length: Math.floor(rand() * 3) }, () => [between(20, 80), between(...inset)]).sort((a, b) => a[0] - b[0]),
    // A slit a few px from the start, where the cut along the previous side ran on past the corner.
    nick: rand() < 0.3 ? [between(6, 16), between(3, 7)] : null,
  }));

  const pts = [];
  edges.forEach((e, side) => {
    const prev = edges[(side + 3) % 4];
    pts.push(pt(side, 0, prev.end, e.start)); // the corner, where this cut meets the last
    if (e.nick) {
      const [along, deep] = e.nick;
      pts.push(pt(side, 0, along, e.start), pt(side, 0, along + 0.4, e.start + deep), pt(side, 0, along + 1, e.start));
    }
    for (const [pct, depth] of e.kinks) pts.push(pt(side, pct, 0, depth));
  });
  return `polygon(${pts.join(', ')})`;
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

const SQUARES = '.panel, .capture-box, .ev-card';

function cut(el) {
  el.style.setProperty('--cut-edge', cutOutline(hashSeed(el.className)));
}

let observer = null;

/** Turn the generated outlines on or off. */
export function setPostit(on) {
  observer?.disconnect();
  observer = null;
  if (!on) return;
  document.querySelectorAll(NOTES).forEach(dress);
  document.querySelectorAll(SQUARES).forEach(cut);
  let n = 0;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(NOTES)) dress(node, n++);
        node.querySelectorAll(NOTES).forEach((el) => dress(el, n++));
        if (node.matches(SQUARES)) cut(node);
        node.querySelectorAll(SQUARES).forEach(cut);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
