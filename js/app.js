import { CLIENT_ID, TARGET_CALENDAR_NAME, DEFAULT_DURATION } from '../config.js';
import * as auth from './auth.js';
import * as gcal from './gcal.js';
import * as L from './logic.js';

const $ = (sel) => document.querySelector(sel);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DRAFT_KEY = 'tb.draft';
const SETTINGS_KEY = 'tb.settings';
const DAY_CACHE_TTL = 60_000;

const todayStr = () => L.ymd(new Date());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtDay = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtHM = (t) => fmtTime(new Date(`2000-01-01T${t}:00`));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Mon, Sep 28" for one-off rows, "Every weekday from Mon, Sep 28 until Fri, Oct 30" for series. */
function whenLabel(row) {
  if (!L.isRecurring(row)) return fmtDay(row.date);
  const until = row.repeat.until ? ` until ${fmtDay(row.repeat.until)}` : '';
  return `${L.describeRepeat(row.repeat)} from ${fmtDay(L.firstOccurrence(row))}${until}`;
}

// ---------------------------------------------------------------- state

const state = {
  rows: [],
  defaultDate: todayStr(),
  focusedId: null,
  agendaDate: null, // null = follow focused row / default date
  calendars: [],
  targetId: null,
  checkIds: null, // null = defaults (primary + target) once calendars load
  includeAllDay: false,
  results: new Map(), // rowId -> {state, conflicts}
  saveErrors: new Map(), // rowId -> message from the last failed insert
  checkedSig: null,
  checking: false,
  saving: false,
  lastSaved: null, // [{calendarId, eventId, link, row}]
  dayCache: new Map(), // date -> {at, events}
  signedIn: false,
  email: '',
};

function newRow(over = {}) {
  const row = { id: uid(), title: '', date: state.defaultDate, start: '', end: '', force: false, ...over };
  row.repeat = cleanRepeat(over.repeat);
  return row;
}

function cleanRepeat(r) {
  if (!r || !['daily', 'weekdays', 'weekly'].includes(r.freq)) return L.noRepeat();
  return {
    freq: r.freq,
    days: Array.isArray(r.days) ? r.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [],
    until: typeof r.until === 'string' ? r.until : '',
  };
}

function loadPersisted() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) {
      state.targetId = s.targetId || null;
      state.checkIds = Array.isArray(s.checkIds) ? s.checkIds : null;
      state.includeAllDay = !!s.includeAllDay;
    }
  } catch { /* ignore */ }
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d && Array.isArray(d.rows)) {
      state.rows = d.rows.map((r) => newRow({
        title: String(r.title || ''), date: r.date || state.defaultDate,
        start: r.start || '', end: r.end || '', force: !!r.force, repeat: r.repeat,
      }));
      if (d.defaultDate && d.defaultDate >= todayStr()) state.defaultDate = d.defaultDate;
    }
  } catch { /* ignore */ }
}

function persistDraft() {
  try {
    const rows = state.rows.filter((r) => !L.isBlank(r) || r.start || r.end)
      .map(({ title, date, start, end, force, repeat }) => ({ title, date, start, end, force, repeat }));
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ rows, defaultDate: state.defaultDate }));
  } catch { /* ignore */ }
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      targetId: state.targetId, checkIds: state.checkIds, includeAllDay: state.includeAllDay,
    }));
  } catch { /* ignore */ }
}

function ensureTrailingBlank() {
  if (!state.rows.length) state.rows.push(newRow());
}

function checkSig() {
  return L.rowsSignature(state.rows.filter((r) => !L.isBlank(r)),
    JSON.stringify([state.checkIds, state.includeAllDay]));
}
const isFresh = () => state.checkedSig !== null && state.checkedSig === checkSig();

function rowStatus(row) {
  if (L.isBlank(row)) return { state: 'blank' };
  const issues = L.validateRow(row);
  if (issues.length) return { state: 'invalid', issues };
  const r = state.results.get(row.id);
  if (!r) return { state: state.checking ? 'checking' : 'unchecked' };
  return isFresh() ? r : { ...r, stale: true };
}

function saveableRows() {
  if (!isFresh()) return [];
  return state.rows.filter((row) => {
    const s = rowStatus(row);
    return s.state === 'ok' || (s.state === 'conflict' && row.force);
  });
}

// ---------------------------------------------------------------- rendering: rows

const rowsEl = $('#rows');
const rowTpl = $('#rowTpl');
const rowEls = new Map();

function renderRows() {
  const ids = new Set(state.rows.map((r) => r.id));
  for (const [id, el] of rowEls) {
    if (!ids.has(id)) { el.remove(); rowEls.delete(id); }
  }
  state.rows.forEach((row, i) => {
    let el = rowEls.get(row.id);
    if (!el) {
      el = rowTpl.content.firstElementChild.cloneNode(true);
      el.dataset.id = row.id;
      rowEls.set(row.id, el);
    }
    if (rowsEl.children[i] !== el) rowsEl.insertBefore(el, rowsEl.children[i] || null);
    el.querySelector('.num').textContent = i + 1;
    syncInput(el.querySelector('.f-title'), row.title);
    syncInput(el.querySelector('.f-date'), row.date);
    syncInput(el.querySelector('.f-start'), row.start);
    syncInput(el.querySelector('.f-end'), row.end);
    renderRepeat(row, el);
    renderRowStatus(row, el, i);
  });
}

const DAY_LETTERS = [[1, 'M'], [2, 'T'], [3, 'W'], [4, 'T'], [5, 'F'], [6, 'S'], [0, 'S']];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Sync the Repeat select and the day-toggle / until sub-line of a row. */
function renderRepeat(row, el = rowEls.get(row.id)) {
  if (!el) return;
  const sel = el.querySelector('.f-repeat');
  if (sel.value !== row.repeat.freq) sel.value = row.repeat.freq;
  const line = el.querySelector('.repeat-line');
  line.hidden = !L.isRecurring(row);
  if (line.hidden) return;
  if (!line.firstChild) {
    line.append(
      h('span', { class: 'days' }, DAY_LETTERS.map(([d, letter]) => h('button', {
        type: 'button', class: 'day-toggle', 'data-day': d, title: DAY_NAMES[d], 'aria-label': DAY_NAMES[d],
      }, letter))),
      h('label', { class: 'until' }, 'until ', h('input', { type: 'date', class: 'f-until', 'aria-label': 'Repeat until (optional)' })),
      h('span', { class: 'muted repeat-note' }),
    );
  }
  const days = new Set(L.repeatDays(row.repeat));
  line.querySelector('.days').hidden = row.repeat.freq !== 'weekly';
  for (const b of line.querySelectorAll('.day-toggle')) {
    const on = days.has(Number(b.dataset.day));
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  }
  syncInput(line.querySelector('.f-until'), row.repeat.until);
  const n = L.validateRow({ ...row, title: row.title || 'x' }).length ? 0 : L.occurrenceDates(row).length;
  line.querySelector('.repeat-note').textContent = row.repeat.until
    ? `${plural(n, 'occurrence')} · checked through ${fmtDay(row.repeat.until)}`
    : `no end · next ${L.REPEAT_HORIZON_DAYS / 7} weeks checked (${plural(n, 'occurrence')})`;
}

function syncInput(input, value) {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}

function renderRowStatus(row, el = rowEls.get(row.id)) {
  if (!el) return;
  const s = rowStatus(row);
  el.className = `row ${s.state}${s.stale ? ' stale' : ''}${row.force && s.state === 'conflict' ? ' forced' : ''}${state.focusedId === row.id ? ' focused' : ''}`;
  const box = el.querySelector('.status');
  box.replaceChildren();
  if (s.state === 'invalid') {
    box.append(h('span', { class: 'pill bad' }, '✗ ', s.issues.join(' · ')));
  } else if (s.state === 'unchecked') {
    box.append(h('span', { class: 'pill idle' }, state.signedIn ? 'Not checked yet' : 'Sign in to check conflicts'));
  } else if (s.state === 'checking') {
    box.append(h('span', { class: 'pill idle' }, 'Checking…'));
  } else if (s.state === 'ok') {
    box.append(h('span', { class: 'pill ok' },
      L.isRecurring(row) ? `✓ Free on all ${L.occurrenceDates(row).length} checked days` : '✓ Free'));
  } else if (s.state === 'conflict') {
    const recurring = L.isRecurring(row);
    const clashDays = new Set(s.conflicts.map((c) => c.occDate)).size;
    const shown = s.conflicts.slice(0, MAX_CONFLICTS_SHOWN);
    const more = s.conflicts.length - shown.length;
    box.append(
      h('span', { class: 'pill warn' }, recurring
        ? `⚠ Conflicts on ${clashDays} of ${L.occurrenceDates(row).length} days`
        : `⚠ Conflicts with ${plural(s.conflicts.length, 'item')}`),
      h('ul', { class: 'conflicts' }, shown.map((c) => conflictItem(c, recurring)),
        more > 0 ? h('li', { class: 'muted' }, `+${more} more`) : null),
      h('label', { class: 'force' },
        h('input', {
          type: 'checkbox',
          checked: row.force,
          onchange: (e) => { row.force = e.target.checked; persistDraft(); renderRowStatus(row); renderActions(); renderAgenda(); },
        }),
        recurring ? 'Save the series anyway' : 'Save anyway'),
    );
  }
  const saveError = state.saveErrors.get(row.id);
  if (saveError) {
    el.classList.add('error');
    box.append(h('div', { class: 'pill bad save-error' }, '✗ Last save failed: ', saveError));
  }
}

const MAX_CONFLICTS_SHOWN = 5;

function conflictItem(c, withDate) {
  const day = withDate ? h('span', { class: 'occ' }, fmtDay(c.occDate)) : null;
  if (c.kind === 'row') {
    return h('li', {}, day,
      h('span', {}, `Row ${c.index + 1}: `, h('b', {}, c.row.title)),
      h('span', { class: 'muted' }, `${fmtHM(c.row.start)}–${fmtHM(c.row.end)} · this batch`));
  }
  const ev = c.event;
  const when = ev.allDay ? 'all day' : `${fmtTime(ev.start)}–${fmtTime(ev.end)}`;
  return h('li', {}, day,
    h('span', { class: 'swatch', style: { background: ev.color || 'var(--muted)' } }),
    ev.link ? h('a', { href: ev.link, target: '_blank', rel: 'noopener' }, h('b', {}, ev.title)) : h('b', {}, ev.title),
    h('span', { class: 'muted' }, `${when} · ${ev.calendarName}`));
}

// ---------------------------------------------------------------- rendering: actions/summary

function renderActions() {
  const filled = state.rows.filter((r) => !L.isBlank(r));
  const counts = { ok: 0, conflict: 0, invalid: 0, unchecked: 0, error: 0, checking: 0 };
  for (const r of filled) counts[rowStatus(r).state]++;
  const saveable = saveableRows();
  const target = state.calendars.find((c) => c.id === state.targetId);

  const parts = [];
  if (!filled.length) parts.push(h('span', { class: 'muted' }, 'Add a block to get started.'));
  if (counts.ok) parts.push(h('span', { class: 'pill ok' }, `✓ ${counts.ok} free`));
  if (counts.conflict) parts.push(h('span', { class: 'pill warn' }, `⚠ ${counts.conflict} conflicting`));
  if (counts.invalid) parts.push(h('span', { class: 'pill bad' }, `✗ ${counts.invalid} incomplete`));
  const failedCount = filled.filter((r) => state.saveErrors.has(r.id)).length;
  if (failedCount) parts.push(h('span', { class: 'pill bad' }, `✗ ${failedCount} failed to save`));
  if (state.checking) parts.push(h('span', { class: 'pill idle' }, 'Checking…'));
  else if (counts.unchecked) parts.push(h('span', { class: 'pill idle' }, `${counts.unchecked} not checked`));
  else if (filled.length && !isFresh() && state.signedIn) parts.push(h('span', { class: 'pill idle' }, 'changed since last check'));
  const summary = $('#summary');
  summary.replaceChildren(...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));

  const checkBtn = $('#checkBtn');
  checkBtn.disabled = state.checking || state.saving || !filled.length;
  checkBtn.textContent = state.checking ? 'Checking…' : 'Check conflicts';

  const saveBtn = $('#saveBtn');
  const skipped = counts.conflict - filled.filter((r) => rowStatus(r).state === 'conflict' && r.force).length;
  saveBtn.disabled = state.saving || state.checking || !saveable.length || !target;
  saveBtn.replaceChildren(
    state.saving ? 'Saving…'
      : saveable.length ? `Save ${plural(saveable.length, 'block')}${skipped > 0 ? ` (skip ${skipped})` : ''}`
        : 'Save',
  );
  saveBtn.title = !target ? 'Choose a calendar to save to (⚙ above)'
    : !isFresh() ? 'Check conflicts first (Ctrl+Enter)' : 'Ctrl+Enter';

  $('#targetSummary').textContent = target ? target.name : (state.signedIn ? 'no calendar selected' : '—');
  const checking = state.calendars.filter((c) => (state.checkIds || []).includes(c.id));
  $('#checkSummary').textContent = checking.length
    ? `· checking ${checking.map((c) => c.name).join(', ')}` : '';
}

let flashTimer = null;
function flash(kind, content, { sticky = false } = {}) {
  const el = $('#flash');
  clearTimeout(flashTimer);
  if (!content) { el.hidden = true; return; }
  el.className = `flash ${kind}`;
  el.replaceChildren(...[].concat(content));
  el.hidden = false;
  if (!sticky) flashTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

function renderAll() {
  renderRows();
  renderActions();
  renderAgenda();
}

// ---------------------------------------------------------------- rendering: settings

function renderSettings() {
  const sel = $('#targetSelect');
  const writable = state.calendars.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer');
  sel.replaceChildren(
    h('option', { value: '' }, '— choose a calendar —'),
    ...writable.map((c) => h('option', { value: c.id, selected: c.id === state.targetId }, c.name + (c.primary ? ' (primary)' : ''))),
  );
  const list = $('#checkList');
  if (!state.calendars.length) {
    list.replaceChildren(h('span', { class: 'muted' }, state.signedIn ? 'Loading calendars…' : 'Sign in to load your calendars.'));
  } else {
    list.replaceChildren(...state.calendars.map((c) => h('label', {},
      h('input', {
        type: 'checkbox', value: c.id, checked: state.checkIds.includes(c.id),
        onchange: (e) => {
          const set = new Set(state.checkIds);
          e.target.checked ? set.add(c.id) : set.delete(c.id);
          state.checkIds = state.calendars.map((x) => x.id).filter((id) => set.has(id));
          persistSettings();
          state.dayCache.clear();
          onRowsChanged({ structural: false });
          loadAgendaDay();
        },
      }),
      h('span', { class: 'swatch', style: { background: c.color } }),
      h('span', { title: c.name }, c.name),
      c.primary ? h('span', { class: 'tag' }, 'primary') : null,
      c.id === state.targetId ? h('span', { class: 'tag' }, 'target') : null,
    )));
  }
  $('#includeAllDay').checked = state.includeAllDay;
}

// ---------------------------------------------------------------- agenda

function agendaDate() {
  if (state.agendaDate) return state.agendaDate;
  const focused = state.rows.find((r) => r.id === state.focusedId);
  return focused?.date || state.defaultDate;
}

let agendaLoadSeq = 0;
async function loadAgendaDay({ force = false } = {}) {
  const date = agendaDate();
  if (!state.signedIn || !auth.isSignedIn() || !state.checkIds?.length) { renderAgenda(); return; }
  const cached = state.dayCache.get(date);
  if (!force && cached && Date.now() - cached.at < DAY_CACHE_TTL) { renderAgenda(); return; }
  const seq = ++agendaLoadSeq;
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(`${L.addDays(date, 1)}T00:00:00`);
  const cals = state.calendars.filter((c) => state.checkIds.includes(c.id));
  try {
    const lists = await Promise.all(cals.map((c) => gcal.listEvents(c.id, start, end)));
    const events = lists.flatMap((items, i) => items
      .map((ev) => L.normalizeEvent(ev, cals[i], { includeAllDay: true }))
      .filter(Boolean));
    state.dayCache.set(date, { at: Date.now(), events });
  } catch (e) {
    if (seq === agendaLoadSeq) $('#agendaNote').textContent = `Couldn't load events: ${e.message}`;
    if (e instanceof gcal.AuthError) setSignedOut();
    return;
  }
  if (seq === agendaLoadSeq) renderAgenda();
}

function renderAgenda() {
  const date = agendaDate();
  $('#agendaTitle').textContent = date === todayStr() ? `Today · ${fmtDay(date)}` : fmtDay(date);
  const cached = state.dayCache.get(date);
  const events = cached?.events || [];
  const note = $('#agendaNote');
  note.textContent = !state.signedIn ? 'Sign in to see your calendar here.'
    : !cached ? 'Loading…'
      : '';

  const allDay = events.filter((e) => e.allDay);
  $('#agendaAllDay').replaceChildren(...allDay.map((e) =>
    h('span', { class: 'allday-chip', style: { background: e.color }, title: `${e.title} · ${e.calendarName}` }, e.title)));

  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const toMin = (d) => Math.round((d.getTime() - dayStart) / 60000);
  const items = events.filter((e) => !e.allDay).map((e) => ({
    kind: 'event', ev: e, s: Math.max(0, toMin(e.start)), e: Math.min(24 * 60, toMin(e.end)),
  })).filter((i) => i.e > i.s);

  const drafts = state.rows.filter((r) => L.occursOn(r, date) && !L.validateRow({ ...r, title: r.title || 'x' }).length);
  for (const r of drafts) {
    const [sh, sm] = r.start.split(':').map(Number);
    const [eh, em] = r.end.split(':').map(Number);
    items.push({ kind: 'draft', row: r, s: sh * 60 + sm, e: eh * 60 + em });
  }
  L.assignLanes(items);

  let from = 7 * 60;
  let to = 21 * 60;
  for (const i of items) { from = Math.min(from, i.s); to = Math.max(to, i.e); }
  from = Math.floor(from / 60) * 60;
  to = Math.min(24 * 60, Math.ceil(to / 60) * 60);
  const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 44;
  const px = (m) => ((m - from) / 60) * hourPx;

  const tl = $('#timeline');
  tl.dataset.from = from;
  tl.dataset.date = date;
  const inner = h('div', { class: 'tl-inner', style: { height: `${px(to)}px` } });
  const children = [];
  for (let m = from; m <= to; m += 60) {
    const label = m < 24 * 60
      ? new Date(2000, 0, 1, m / 60).toLocaleTimeString(undefined, { hour: 'numeric' }) : '';
    children.push(h('div', { class: 'hour', style: { top: `${px(m)}px` } }, h('span', {}, label)));
  }
  if (date === todayStr()) {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    if (m >= from && m <= to) children.push(h('div', { class: 'now', style: { top: `${px(m)}px` } }));
  }
  for (const i of items) {
    const width = 100 / i.lanes;
    const style = {
      top: `${px(i.s)}px`,
      height: `${Math.max(px(i.e) - px(i.s) - 1, 14)}px`,
      left: `calc(${i.lane * width}% + 3px)`,
      width: `calc(${width}% - 6px)`,
    };
    if (i.kind === 'event') {
      style.background = i.ev.color || 'var(--muted)';
      children.push(h('div', {
        class: 'blk', style, title: `${i.ev.title}\n${fmtTime(i.ev.start)}–${fmtTime(i.ev.end)} · ${i.ev.calendarName}`,
      }, h('b', {}, i.ev.title), i.e - i.s >= 45 ? `${fmtTime(i.ev.start)} · ${i.ev.calendarName}` : null));
    } else {
      const st = rowStatus(i.row).state;
      children.push(h('div', {
        class: `blk draft${st === 'conflict' && !i.row.force ? ' conflict' : ''}`,
        style,
        title: `${i.row.title || '(untitled)'}\n${fmtHM(i.row.start)}–${fmtHM(i.row.end)} · new block`,
        onclick: (e) => { e.stopPropagation(); focusRow(i.row.id, '.f-title'); },
      }, h('b', {}, i.row.title || '(untitled)'), i.e - i.s >= 45 ? `${fmtHM(i.row.start)} · new` : null));
    }
  }
  inner.replaceChildren(...children);
  tl.replaceChildren(inner);

  const legendCals = state.calendars.filter((c) => (state.checkIds || []).includes(c.id));
  $('#legend').replaceChildren(
    h('span', {}, h('span', { class: 'swatch draft-swatch' }), 'New blocks'),
    ...legendCals.map((c) => h('span', {}, h('span', { class: 'swatch', style: { background: c.color } }), c.name)),
  );
}

// ---------------------------------------------------------------- row editing

function focusRow(id, selector = '.f-title') {
  const el = rowEls.get(id);
  el?.querySelector(selector)?.focus();
}

function addRowAfter(prev, focus = true) {
  const base = prev || state.rows[state.rows.length - 1];
  const over = {};
  if (base) {
    over.date = base.date || state.defaultDate;
    if (HHMM.test(base.end)) {
      over.start = base.end;
      over.end = L.addMinutes(base.end, DEFAULT_DURATION);
      if (over.end <= over.start) { over.start = ''; over.end = ''; }
    }
  }
  const row = newRow(over);
  const idx = base ? state.rows.indexOf(base) + 1 : state.rows.length;
  state.rows.splice(idx, 0, row);
  onRowsChanged();
  if (focus) focusRow(row.id);
  return row;
}

function removeRow(row, focusPrev = false) {
  const idx = state.rows.indexOf(row);
  if (idx < 0) return;
  state.rows.splice(idx, 1);
  state.results.delete(row.id);
  ensureTrailingBlank();
  onRowsChanged();
  if (focusPrev) {
    const target = state.rows[Math.max(0, idx - 1)];
    focusRow(target.id);
  }
}

const HHMM = /^\d{2}:\d{2}$/;
const lastDuration = new Map(); // rowId -> last positive duration, to keep it when start changes

function rememberDuration(row) {
  if (HHMM.test(row.start) && HHMM.test(row.end)) {
    const d = L.minutesBetween(row.start, row.end);
    if (d > 0) lastDuration.set(row.id, d);
  }
}

let autoCheckTimer = null;
function onRowsChanged({ structural = true } = {}) {
  persistDraft();
  if (structural) renderRows();
  else state.rows.forEach((r) => renderRowStatus(r));
  renderActions();
  renderAgenda();
  scheduleAutoCheck();
}

function scheduleAutoCheck() {
  clearTimeout(autoCheckTimer);
  if (!state.signedIn || isFresh()) return;
  autoCheckTimer = setTimeout(() => {
    // Only auto-check silently with a live token (no popups outside a user gesture).
    if (auth.isSignedIn() && !state.saving) runCheck();
  }, 700);
}

rowsEl.addEventListener('input', (e) => {
  const li = e.target.closest('.row');
  const row = li && state.rows.find((r) => r.id === li.dataset.id);
  if (!row) return;
  const t = e.target;
  if (t.classList.contains('f-title')) row.title = t.value;
  else if (t.classList.contains('f-date')) row.date = t.value;
  else if (t.classList.contains('f-until')) row.repeat.until = t.value;
  else if (t.classList.contains('f-repeat')) {
    row.repeat.freq = t.value;
    if (t.value === 'weekly' && !row.repeat.days.length && row.date) row.repeat.days = [L.weekdayOf(row.date)];
  }
  else if (t.classList.contains('f-start')) {
    rememberDuration(row);
    const parsed = L.parseTime(t.value);
    row.start = parsed || t.value.trim();
    if (parsed) {
      // Like Google Calendar: moving the start keeps the duration.
      const dur = lastDuration.get(row.id) || DEFAULT_DURATION;
      if (!HHMM.test(row.end) || lastDuration.has(row.id) || row.end <= parsed) row.end = L.addMinutes(parsed, dur);
      syncInput(li.querySelector('.f-end'), row.end);
    }
  } else if (t.classList.contains('f-end')) {
    row.end = L.parseTime(t.value) || t.value.trim();
    rememberDuration(row);
  } else return;
  state.saveErrors.delete(row.id);
  renderRepeat(row, li);
  if (t.classList.contains('f-date') && state.focusedId === row.id) state.agendaDate = null;
  onRowsChanged({ structural: false });
  if (t.classList.contains('f-date')) loadAgendaDay();
});

// Show the normalized time (e.g. "930" -> "09:30") once the field loses focus.
rowsEl.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!t.classList.contains('f-start') && !t.classList.contains('f-end')) return;
  const row = state.rows.find((r) => r.id === t.closest('.row')?.dataset.id);
  if (row) t.value = t.classList.contains('f-start') ? row.start : row.end;
});

rowsEl.addEventListener('click', (e) => {
  const toggle = e.target.closest('.day-toggle');
  if (toggle) {
    const li = toggle.closest('.row');
    const row = state.rows.find((r) => r.id === li.dataset.id);
    const d = Number(toggle.dataset.day);
    const days = new Set(row.repeat.days);
    days.has(d) ? days.delete(d) : days.add(d);
    row.repeat.days = [...days].sort();
    state.saveErrors.delete(row.id);
    renderRepeat(row, li);
    onRowsChanged({ structural: false });
    return;
  }
  if (!e.target.classList.contains('f-remove')) return;
  const li = e.target.closest('.row');
  const row = state.rows.find((r) => r.id === li.dataset.id);
  if (row) removeRow(row);
});

rowsEl.addEventListener('focusin', (e) => {
  const li = e.target.closest('.row');
  if (!li || state.focusedId === li.dataset.id) return;
  const prevDate = agendaDate();
  state.focusedId = li.dataset.id;
  state.agendaDate = null;
  for (const [id, el] of rowEls) el.classList.toggle('focused', id === state.focusedId);
  if (agendaDate() !== prevDate) loadAgendaDay();
  else renderAgenda();
});

rowsEl.addEventListener('keydown', (e) => {
  const li = e.target.closest('.row');
  const row = li && state.rows.find((r) => r.id === li.dataset.id);
  if (!row) return;
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const idx = state.rows.indexOf(row);
    const next = state.rows[idx + 1];
    if (e.shiftKey) {
      if (idx > 0) focusRow(state.rows[idx - 1].id);
    } else if (next) focusRow(next.id);
    else if (!L.isBlank(row)) addRowAfter(row);
  } else if (e.key === 'Backspace' && e.target.classList.contains('f-title')
    && !e.target.value && state.rows.length > 1) {
    e.preventDefault();
    removeRow(row, true);
  }
});

// ---------------------------------------------------------------- check & save

async function fetchConflictEvents(rows) {
  const range = L.rowsRange(rows);
  if (!range) return [];
  const cals = state.calendars.filter((c) => (state.checkIds || []).includes(c.id));
  const lists = await Promise.all(cals.map((c) => gcal.listEvents(c.id, range.start, range.end)));
  return lists.flatMap((items, i) => items
    .map((ev) => L.normalizeEvent(ev, cals[i], { includeAllDay: state.includeAllDay }))
    .filter(Boolean));
}

let checkSeq = 0;
/** Re-checks all rows. Returns true when results are fresh afterwards. */
async function runCheck() {
  const sig = checkSig();
  const seq = ++checkSeq;
  state.checking = true;
  renderActions();
  state.rows.forEach((r) => renderRowStatus(r));
  try {
    const events = await fetchConflictEvents(state.rows);
    if (seq !== checkSeq || sig !== checkSig()) return false; // edited meanwhile; a newer check follows
    const conflicts = L.findConflicts(state.rows, events);
    const results = new Map();
    for (const row of state.rows) {
      const c = conflicts.get(row.id);
      if (!c) continue;
      results.set(row.id, c.length ? { state: 'conflict', conflicts: c } : { state: 'ok' });
    }
    state.results = results;
    state.checkedSig = sig;
    return true;
  } catch (e) {
    if (seq === checkSeq) {
      flash('bad', `Couldn't check your calendar: ${e.message}`);
      if (e instanceof gcal.AuthError) setSignedOut();
    }
    return false;
  } finally {
    if (seq === checkSeq) {
      state.checking = false;
      state.rows.forEach((r) => renderRowStatus(r));
      renderActions();
      renderAgenda();
    }
  }
}

async function ensureAuthed() {
  // Must be called first thing in a user-gesture handler.
  if (!state.signedIn) {
    await doSignIn();
    return state.signedIn;
  }
  await auth.getToken();
  return true;
}

async function onCheck() {
  try {
    if (!(await ensureAuthed())) return;
  } catch (e) { flash('bad', e.message); return; }
  await runCheck();
}

async function onSave() {
  const target = state.calendars.find((c) => c.id === state.targetId);
  if (!target) { flash('bad', 'Choose a calendar to save to under ⚙ Save to.'); $('#settings').open = true; return; }
  const planned = saveableRows().map((r) => r.id);
  if (!planned.length) return;
  try {
    await auth.getToken();
  } catch (e) { flash('bad', e.message); return; }

  state.saving = true;
  renderActions();
  try {
    // Re-check right before writing so nothing changed under us.
    if (!(await runCheck())) return;
    const now = new Set(saveableRows().map((r) => r.id));
    const lost = planned.filter((id) => !now.has(id));
    if (lost.length) {
      flash('bad', `New conflicts appeared for ${plural(lost.length, 'block')}. Review them, then save again.`);
      return;
    }
    const rows = state.rows.filter((r) => planned.includes(r.id));
    rows.forEach((r) => state.saveErrors.delete(r.id));
    const res = await gcal.mapLimit(rows, 3, (row) => gcal.insertEvent(target.id, L.buildEventPayload(row, TZ)));
    const saved = [];
    res.forEach((r, i) => {
      if (r.ok) {
        saved.push({
          calendarId: target.id, eventId: r.value.id, link: r.value.htmlLink,
          row: { ...rows[i], repeat: { ...rows[i].repeat, days: [...rows[i].repeat.days] } },
        });
      }
      else state.saveErrors.set(rows[i].id, r.error.message);
    });
    const savedIds = new Set(saved.map((s) => s.row.id));
    state.rows = state.rows.filter((r) => !savedIds.has(r.id));
    ensureTrailingBlank();
    state.lastSaved = saved.length ? saved : state.lastSaved;
    state.dayCache.clear();
    const failed = rows.length - saved.length;
    const failNote = failed ? h('div', {}, `${plural(failed, 'block')} failed to save — see the rows above.`) : null;
    if (saved.length) {
      state.checkedSig = null;
      flash(failed ? 'bad' : 'ok', [
        h('span', {}, `Saved ${plural(saved.length, 'block')} to ${target.name}.`),
        h('button', { type: 'button', class: 'btn', onclick: onUndo }, 'Undo'),
        h('ul', {}, saved.map((s) => h('li', {},
          h('a', { href: s.link, target: '_blank', rel: 'noopener' }, s.row.title),
          ` · ${whenLabel(s.row)} · ${fmtHM(s.row.start)}–${fmtHM(s.row.end)}`))),
        failNote,
      ].filter(Boolean), { sticky: true });
    } else if (failed) {
      flash('bad', failNote, { sticky: true });
    }
  } catch (e) {
    flash('bad', `Save failed: ${e.message}`);
    if (e instanceof gcal.AuthError) setSignedOut();
  } finally {
    state.saving = false;
    onRowsChanged();
    loadAgendaDay({ force: true });
  }
}

async function onUndo() {
  const batch = state.lastSaved;
  if (!batch?.length) return;
  try { await auth.getToken(); } catch (e) { flash('bad', e.message); return; }
  flash('info', 'Undoing…', { sticky: true });
  const res = await gcal.mapLimit(batch, 3, (s) => gcal.deleteEvent(s.calendarId, s.eventId));
  const restored = [];
  const failed = [];
  res.forEach((r, i) => (r.ok || /deleted|not found/i.test(r.error.message) ? restored : failed).push(batch[i]));
  state.lastSaved = failed.length ? failed : null;
  state.rows = state.rows.filter((r) => !L.isBlank(r) || r.start || r.end);
  state.rows.push(...restored.map((s) => newRow({ ...s.row, id: uid() })));
  ensureTrailingBlank();
  state.dayCache.clear();
  flash(failed.length ? 'bad' : 'ok', failed.length
    ? `Removed ${restored.length}; ${failed.length} could not be removed.`
    : `Removed ${plural(restored.length, 'block')} from Google Calendar and put them back here.`);
  onRowsChanged();
  loadAgendaDay({ force: true });
}

// ---------------------------------------------------------------- auth & calendars

function setSignedOut() {
  state.signedIn = false;
  state.email = '';
  renderAccount();
  renderAll();
}

function renderAccount() {
  $('#signInBtn').hidden = state.signedIn;
  $('#signOutBtn').hidden = !state.signedIn;
  $('#accountLabel').textContent = state.email;
}

async function doSignIn() {
  try {
    await auth.signIn();
  } catch (e) {
    flash('bad', e.message);
    return;
  }
  state.signedIn = true;
  await afterSignIn();
}

async function afterSignIn() {
  renderAccount();
  try {
    state.calendars = await gcal.listCalendars();
  } catch (e) {
    flash('bad', `Couldn't load calendars: ${e.message}`);
    if (e instanceof gcal.AuthError) setSignedOut();
    return;
  }
  const primary = state.calendars.find((c) => c.primary);
  if (primary) {
    state.email = primary.id;
    auth.setLoginHint(primary.id);
  }
  if (!state.calendars.some((c) => c.id === state.targetId)) {
    const byName = state.calendars.find((c) => c.name?.trim().toLowerCase() === TARGET_CALENDAR_NAME.toLowerCase());
    state.targetId = byName?.id || null;
  }
  const known = new Set(state.calendars.map((c) => c.id));
  if (!state.checkIds) state.checkIds = [primary?.id, state.targetId].filter(Boolean);
  state.checkIds = state.checkIds.filter((id) => known.has(id));
  persistSettings();
  if (!state.targetId) {
    flash('bad', `No calendar named “${TARGET_CALENDAR_NAME}” found. Create it in Google Calendar, or pick another under ⚙.`, { sticky: true });
    $('#settings').open = true;
  }
  renderAccount();
  renderSettings();
  renderAll();
  loadAgendaDay();
  scheduleAutoCheck();
}

// ---------------------------------------------------------------- date bar & hash

function setDefaultDate(date, { moveRows = true } = {}) {
  if (!date || date === state.defaultDate) return;
  const old = state.defaultDate;
  state.defaultDate = date;
  // Rows on the old planning date move with it (only untouched rows when opened from a bookmark).
  state.rows.forEach((r) => {
    if (!r.date || (r.date === old && (moveRows || L.isBlank(r)))) r.date = date;
  });
  state.agendaDate = null;
  $('#defaultDate').value = date;
  renderDateChips();
  onRowsChanged();
  loadAgendaDay();
}

function renderDateChips() {
  $('#todayBtn').classList.toggle('active', state.defaultDate === todayStr());
  $('#tomorrowBtn').classList.toggle('active', state.defaultDate === L.addDays(todayStr(), 1));
}

function applyHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const d = L.resolveDate(params.get('date') || '', todayStr());
  if (d) setDefaultDate(d, { moveRows: false });
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('#defaultDate').addEventListener('change', (e) => setDefaultDate(e.target.value));
  $('#prevDay').addEventListener('click', () => setDefaultDate(L.addDays(state.defaultDate, -1)));
  $('#nextDay').addEventListener('click', () => setDefaultDate(L.addDays(state.defaultDate, 1)));
  $('#todayBtn').addEventListener('click', () => setDefaultDate(todayStr()));
  $('#tomorrowBtn').addEventListener('click', () => setDefaultDate(L.addDays(todayStr(), 1)));

  $('#agendaPrev').addEventListener('click', () => { state.agendaDate = L.addDays(agendaDate(), -1); loadAgendaDay(); });
  $('#agendaNext').addEventListener('click', () => { state.agendaDate = L.addDays(agendaDate(), 1); loadAgendaDay(); });

  $('#timeline').addEventListener('click', (e) => {
    if (e.target.closest('.blk')) return;
    const tl = e.currentTarget;
    const inner = tl.querySelector('.tl-inner');
    if (!inner) return;
    const rect = inner.getBoundingClientRect();
    const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 44;
    const mins = Number(tl.dataset.from) + ((e.clientY - rect.top) / hourPx) * 60;
    const snapped = Math.min(23 * 60, Math.max(0, Math.floor(mins / 15) * 15));
    const start = `${String(Math.floor(snapped / 60)).padStart(2, '0')}:${String(snapped % 60).padStart(2, '0')}`;
    const fields = { date: tl.dataset.date, start, end: L.addMinutes(start, DEFAULT_DURATION) };
    const blank = state.rows.find((r) => L.isBlank(r));
    let row;
    if (blank) {
      Object.assign(blank, fields);
      row = blank;
      onRowsChanged();
    } else {
      row = newRow(fields);
      state.rows.push(row);
      onRowsChanged();
    }
    state.agendaDate = fields.date;
    focusRow(row.id);
  });

  $('#signInBtn').addEventListener('click', doSignIn);
  $('#signOutBtn').addEventListener('click', () => {
    auth.signOut();
    state.calendars = [];
    state.dayCache.clear();
    state.results.clear();
    state.checkedSig = null;
    setSignedOut();
    renderSettings();
  });

  $('#targetSelect').addEventListener('change', (e) => {
    state.targetId = e.target.value || null;
    if (state.targetId && !state.checkIds.includes(state.targetId)) {
      state.checkIds = state.calendars.map((c) => c.id).filter((id) => id === state.targetId || state.checkIds.includes(id));
      state.dayCache.clear();
      loadAgendaDay();
    }
    persistSettings();
    renderSettings();
    onRowsChanged({ structural: false });
  });
  $('#includeAllDay').addEventListener('change', (e) => {
    state.includeAllDay = e.target.checked;
    persistSettings();
    onRowsChanged({ structural: false });
  });

  $('#addRowBtn').addEventListener('click', () => {
    const blank = state.rows.find((r) => L.isBlank(r) && !r.start);
    if (blank) focusRow(blank.id);
    else addRowAfter(null);
  });
  $('#clearBtn').addEventListener('click', () => {
    const filled = state.rows.filter((r) => !L.isBlank(r)).length;
    if (filled > 1 && !confirm(`Clear all ${filled} blocks from the list? (Nothing is deleted from Google Calendar.)`)) return;
    state.rows = [];
    state.results.clear();
    ensureTrailingBlank();
    onRowsChanged();
    focusRow(state.rows[0].id);
  });

  $('#checkBtn').addEventListener('click', onCheck);
  $('#saveBtn').addEventListener('click', onSave);

  const addQuick = () => {
    const { rows, errors } = L.parseQuickText($('#quickText').value, state.defaultDate, todayStr());
    $('#quickErrors').replaceChildren(...errors.map((er) => h('li', {}, `Line ${er.line}: ${er.reason} — “${er.text.trim()}”`)));
    if (!rows.length) return;
    state.rows = state.rows.filter((r) => !L.isBlank(r) || r.start || r.end);
    state.rows.push(...rows.map((r) => newRow(r)));
    if (!errors.length) $('#quickText').value = '';
    onRowsChanged();
    flash('info', `Added ${plural(rows.length, 'block')} from your plan.`);
  };
  $('#quickAddBtn').addEventListener('click', addQuick);
  $('#quickText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      addQuick();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (state.checking || state.saving) return;
      if (isFresh() && saveableRows().length) onSave();
      else onCheck();
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setDefaultDate(L.addDays(state.defaultDate, e.key === 'ArrowLeft' ? -1 : 1));
    }
  });

  window.addEventListener('hashchange', applyHash);
  window.addEventListener('beforeunload', persistDraft);
  // Keep the "now" line and "today" label current if the tab stays open.
  setInterval(renderAgenda, 5 * 60_000);
}

async function main() {
  loadPersisted();
  ensureTrailingBlank();
  $('#defaultDate').value = state.defaultDate;
  wire();
  applyHash();
  renderDateChips();
  renderAccount();
  renderSettings();
  renderAll();

  if (!CLIENT_ID || CLIENT_ID.startsWith('PASTE_')) {
    $('#setupBanner').hidden = false;
    $('#signInBtn').disabled = true;
    return;
  }
  try {
    await auth.initAuth(CLIENT_ID);
  } catch (e) {
    flash('bad', e.message, { sticky: true });
    $('#signInBtn').disabled = true;
    return;
  }
  if (auth.isSignedIn()) {
    state.signedIn = true;
    await afterSignIn();
  }
  const first = state.rows.find((r) => L.isBlank(r)) || state.rows[0];
  if (document.activeElement === document.body) focusRow(first.id);
}

main();
