// Pure helpers for the Fitness section (lifting log, progress, body weight), ported from Iron Log.
// Everything is a flat record list so it syncs through the same per-record store as habits:
//   programs  {id, name, order, exercises: [{id, name}]}
//   sessions  {id: "<exercise>@<date>", ex, date, sets: [{weight, reps}]}
//   weigh-ins {id: <date>, date, weight}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

// Exercise ids are what sessions are keyed on; these match Iron Log's defaults so imported history lines up.
// Stamped 0 so a device that hasn't synced yet never overwrites the real programs with these.
export const DEFAULT_PROGRAMS = [
  { id: 'tue', name: 'Tuesday', order: 0, exercises: [{ id: 'front-squat', name: 'Front Squat' }, { id: 'bench', name: 'Bench Press' }, { id: 'pullup', name: 'Pull-ups' }], createdAt: 0, updatedAt: 0 },
  { id: 'thu', name: 'Thursday', order: 1, exercises: [{ id: 'deadlift', name: 'Deadlift' }, { id: 'ohp', name: 'Army Press' }, { id: 'db-row', name: 'One-arm DB Row' }], createdAt: 0, updatedAt: 0 },
];

// ---------------------------------------------------------------- cleaning

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const cleanSet = (s) => ({ weight: String(s?.weight ?? '').trim(), reps: String(s?.reps ?? '').trim() });
const stamps = (x) => ({ createdAt: Number(x.createdAt) || 0, updatedAt: Number(x.updatedAt) || 0 });

export function cleanPrograms(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && p.id).map((p, i) => ({
    id: String(p.id), name: String(p.name || ''), order: Number.isFinite(p.order) ? p.order : i,
    exercises: (Array.isArray(p.exercises) ? p.exercises : []).filter((e) => e && e.id).map((e) => ({ id: String(e.id), name: String(e.name || '') })),
    ...stamps(p),
  }));
}

export function cleanSessions(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && s.ex && DATE_RE.test(s.date || '')).map((s) => ({
    id: sessionId(s.ex, s.date), ex: String(s.ex), date: s.date,
    sets: (Array.isArray(s.sets) ? s.sets : []).map(cleanSet).filter((x) => x.weight && x.reps),
    ...stamps(s),
  }));
}

export function cleanWeighins(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((w) => w && DATE_RE.test(w.date || '')).map((w) => ({ id: w.date, date: w.date, weight: num(w.weight), ...stamps(w) }));
}

export const sessionId = (ex, date) => `${ex}@${date}`;
export const byDate = (a, b) => a.date.localeCompare(b.date);
export const sortPrograms = (programs) => [...programs].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

// ---------------------------------------------------------------- programs and sessions

/** Index of the split day named after `today` ("Tuesday" on a Tuesday), or -1. */
export function todaysProgram(programs, today) {
  const name = new Date(`${today}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
  return programs.findIndex((p) => p.name.trim().toLowerCase() === name);
}

/** Sessions of one exercise, oldest first. */
export const exerciseSessions = (sessions, ex) => sessions.filter((s) => s.ex === ex).sort(byDate);

export const maxWeight = (sets) => Math.max(0, ...sets.map((s) => num(s.weight)));

export const setsToText = (sets) => (sets || []).map((s) => `${s.weight}×${s.reps}`).join(' / ');

/** "75×5 / 80x3" → [{weight:'75',reps:'5'}, {weight:'80',reps:'3'}]; unreadable parts are dropped. */
export function textToSets(text) {
  return String(text || '').split('/').map((p) => {
    const m = p.trim().match(/^([0-9.]+)\s*[×xX*]\s*([0-9]+)$/);
    return m ? { weight: m[1], reps: m[2] } : null;
  }).filter(Boolean);
}

/**
 * Turn today's set inputs into session records: one per exercise that has at least one complete set.
 * `inputs` is {exerciseId: [{weight, reps}]}.
 */
export function sessionsFromInputs(inputs, date) {
  return Object.entries(inputs).map(([ex, sets]) => {
    const done = sets.map(cleanSet).filter((s) => s.weight && s.reps);
    return done.length ? { id: sessionId(ex, date), ex, date, sets: done } : null;
  }).filter(Boolean);
}

/** Replace or add records by id, keeping the others. */
export function upsert(items, records) {
  const next = new Map(records.map((r) => [r.id, r]));
  const out = items.map((x) => (next.has(x.id) ? { ...x, ...next.get(x.id) } : x));
  const have = new Set(items.map((x) => x.id));
  return out.concat(records.filter((r) => !have.has(r.id)));
}

// ---------------------------------------------------------------- charts

export const RANGES = [
  { key: '1m', label: '1M', months: 1 }, { key: '3m', label: '3M', months: 3 },
  { key: '6m', label: '6M', months: 6 }, { key: '1y', label: '1Y', months: 12 }, { key: 'all', label: 'All' },
];

export function rangeCutoff(key, today) {
  const r = RANGES.find((x) => x.key === key);
  if (!r || !r.months) return null;
  const [y, m, d] = today.split('-').map(Number);
  const c = new Date(y, m - 1 - r.months, d);
  return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}-${String(c.getDate()).padStart(2, '0')}`;
}

/** Entries are any {date, ...}; 'all' keeps everything. */
export function inRange(entries, key, today) {
  const cutoff = rangeCutoff(key, today);
  return cutoff ? entries.filter((e) => e.date >= cutoff) : entries;
}

/**
 * Exponential moving average weighted by real elapsed days, so the trend means the same thing
 * whether weigh-ins are daily or sporadic. A long gap gives alpha ~1, so the curve meets the new
 * reading instead of dragging a stale value across the gap. Null with fewer than 3 points.
 */
export function emaTrend(entries, tauDays = 7) {
  if (entries.length < 3) return null;
  const out = [entries[0].weight];
  for (let i = 1; i < entries.length; i++) {
    const dDays = (new Date(entries[i].date) - new Date(entries[i - 1].date)) / 86_400_000;
    const alpha = 1 - Math.exp(-Math.max(0, dDays) / tauDays);
    out.push(alpha * entries[i].weight + (1 - alpha) * out[i - 1]);
  }
  return out;
}

// ---------------------------------------------------------------- Iron Log import

/**
 * Convert Iron Log's data ({programs, history: {exId: [{date, sets}]}, bodyweight: [{date, weight}]},
 * from Firebase or its IndexedDB copy) into Fitness records.
 */
export function fromIronLog(src) {
  const programs = cleanPrograms((Array.isArray(src?.programs) ? src.programs : Object.values(isObj(src?.programs) ? src.programs : {}))
    .map((p, i) => ({ ...p, order: i, exercises: Array.isArray(p?.exercises) ? p.exercises : Object.values(p?.exercises || {}) })));
  const sessions = [];
  for (const [ex, list] of Object.entries(isObj(src?.history) ? src.history : {})) {
    for (const s of Array.isArray(list) ? list : Object.values(list || {})) {
      sessions.push({ ex, date: s?.date, sets: Array.isArray(s?.sets) ? s.sets : Object.values(s?.sets || {}) });
    }
  }
  const bw = Array.isArray(src?.bodyweight) ? src.bodyweight : Object.values(src?.bodyweight || {});
  return { programs, sessions: cleanSessions(sessions), weighins: cleanWeighins(bw) };
}

/**
 * Add imported records to `items`. A record already here wins (it was logged in this app, after
 * Iron Log), except one still stamped 0 (an untouched default), which the import replaces.
 * Returns {items, added}. Running it again adds nothing.
 */
export function mergeImport(items, imported, now) {
  const have = new Map(items.map((x) => [x.id, x]));
  let added = 0;
  const out = items.map((x) => {
    const imp = imported.find((r) => r.id === x.id);
    if (imp && !(x.updatedAt || x.createdAt)) { added++; return { ...imp, createdAt: now, updatedAt: now }; }
    return x;
  });
  for (const r of imported) {
    if (have.has(r.id)) continue;
    have.set(r.id, r);
    out.push({ ...r, createdAt: now, updatedAt: now });
    added++;
  }
  return { items: out, added };
}

/** Combine two Iron Log sources (Firebase and the local IndexedDB copy); `b` wins per date. */
export function combineIronLog(a, b) {
  const pick = (x, y) => [...new Map([...x, ...y].map((r) => [r.id, r])).values()];
  return {
    programs: b.programs.length ? b.programs : a.programs,
    sessions: pick(a.sessions, b.sessions),
    weighins: pick(a.weighins, b.weighins),
  };
}
