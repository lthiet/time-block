import { CLIENT_ID, TARGET_CALENDAR_NAME, TASKS_CALENDAR_NAME, DEFAULT_DURATION, TASK_DURATION } from '../config.js';
import * as auth from './auth.js';
import * as gcal from './gcal.js';
import * as L from './logic.js';

const $ = (sel) => document.querySelector(sel);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DRAFT_KEY = 'tb.draft';
const SETTINGS_KEY = 'tb.settings';
const TASKS_KEY = 'tb.tasks';
const DAY_CACHE_TTL = 60_000;

const todayStr = () => L.ymd(new Date());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    }
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
// 24-hour clock everywhere (e.g. 08:00, 17:30).
const fmtTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  view: 'week', // calendar panel: 'week' (default) | 'day'
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
  tasks: [], // [{id, title, status, waitingOn, waitingSince, createdAt, doneAt, scheduled}]
  showDone: false,
  tasksCalId: null, // the "Tasks" calendar that scheduled tasks are saved to
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
      state.view = s.calView === 'day' ? 'day' : 'week';
      state.showDone = !!s.showDone;
    }
  } catch { /* ignore */ }
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d && Array.isArray(d.rows)) {
      state.rows = d.rows.map((r) => newRow({
        title: String(r.title || ''), date: r.date || state.defaultDate,
        start: r.start || '', end: r.end || '', force: !!r.force, repeat: r.repeat,
        cal: r.cal === 'tasks' ? 'tasks' : undefined, taskId: r.taskId || undefined,
      }));
      if (d.defaultDate && d.defaultDate >= todayStr()) state.defaultDate = d.defaultDate;
    }
  } catch { /* ignore */ }
  try {
    const t = JSON.parse(localStorage.getItem(TASKS_KEY) || 'null');
    if (Array.isArray(t)) {
      state.tasks = t.filter((x) => x && x.id && L.TASK_STATUSES.includes(x.status)).map((x) => ({
        id: String(x.id), title: String(x.title || ''), status: x.status, waitingOn: String(x.waitingOn || ''),
        waitingSince: x.waitingSince || null, createdAt: x.createdAt || Date.now(), doneAt: x.doneAt || null,
        scheduled: x.scheduled || null,
      }));
    }
  } catch { /* ignore */ }
}

function persistDraft() {
  try {
    const rows = state.rows.filter((r) => !L.isBlank(r) || r.start || r.end)
      .map(({ title, date, start, end, force, repeat, cal, taskId }) => ({ title, date, start, end, force, repeat, cal, taskId }));
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ rows, defaultDate: state.defaultDate }));
  } catch { /* ignore */ }
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      targetId: state.targetId, checkIds: state.checkIds, includeAllDay: state.includeAllDay, calView: state.view,
      showDone: state.showDone,
    }));
  } catch { /* ignore */ }
}

function persistTasks() {
  try { localStorage.setItem(TASKS_KEY, JSON.stringify(state.tasks)); } catch { /* ignore */ }
}

const isTaskRow = (row) => row.cal === 'tasks';

/** Calendar a row is saved to: the "Tasks" calendar for scheduled tasks, the target otherwise. */
function rowCalendar(row) {
  const id = isTaskRow(row) ? state.tasksCalId : state.targetId;
  return state.calendars.find((c) => c.id === id);
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
  if (isTaskRow(row) && state.calendars.length && !rowCalendar(row)) issues.push(`No calendar named “${TASKS_CALENDAR_NAME}”`);
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
  if (isTaskRow(row)) box.append(h('span', { class: 'tag task-tag' }, `→ ${TASKS_CALENDAR_NAME}`), ' ');
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
  const missingCal = saveable.some((r) => !rowCalendar(r));
  saveBtn.disabled = state.saving || state.checking || !saveable.length || missingCal;
  saveBtn.replaceChildren(
    state.saving ? 'Saving…'
      : saveable.length ? `Save ${plural(saveable.length, 'block')}${skipped > 0 ? ` (skip ${skipped})` : ''}`
        : 'Save',
  );
  saveBtn.title = missingCal || (!target && !saveable.length) ? 'Choose a calendar to save to (⚙ above)'
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
  renderTasks();
}

// ---------------------------------------------------------------- rendering: settings

function renderSettings() {
  // New blocks take the colour of the calendar they'll be saved to (e.g. Time Blocking).
  const targetColor = state.calendars.find((c) => c.id === state.targetId)?.color;
  if (targetColor) document.documentElement.style.setProperty('--new', targetColor);
  else document.documentElement.style.removeProperty('--new');
  const tasksColor = state.calendars.find((c) => c.id === state.tasksCalId)?.color;
  if (tasksColor) document.documentElement.style.setProperty('--task', tasksColor);
  else document.documentElement.style.removeProperty('--task');
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

// ---------------------------------------------------------------- calendar panel (day / week)

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const gridCols = (n) => `repeat(${n}, minmax(0, 1fr))`;

function agendaDate() {
  if (state.agendaDate) return state.agendaDate;
  const focused = state.rows.find((r) => r.id === state.focusedId);
  return focused?.date || state.defaultDate;
}

/** Dates shown in the calendar panel: one day, or Monday–Sunday of that day's week. */
function visibleDates() {
  const date = agendaDate();
  if (state.view !== 'week') return [date];
  const monday = L.addDays(date, -((L.weekdayOf(date) + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => L.addDays(monday, i));
}

function setView(view) {
  if (view !== 'day' && view !== 'week') return;
  state.view = view;
  persistSettings();
  loadAgendaDay();
}

const isCached = (d) => {
  const c = state.dayCache.get(d);
  return c && Date.now() - c.at < DAY_CACHE_TTL;
};

let agendaLoadSeq = 0;
/** Load events for the visible day(s) in one request per calendar, then render. */
async function loadAgendaDay({ force = false } = {}) {
  const dates = visibleDates();
  if (!state.signedIn || !auth.isSignedIn() || !state.checkIds?.length) { renderAgenda(); return; }
  const missing = force ? dates : dates.filter((d) => !isCached(d));
  renderAgenda();
  if (!missing.length) return;
  const seq = ++agendaLoadSeq;
  const first = missing[0];
  const last = missing[missing.length - 1];
  const cals = state.calendars.filter((c) => state.checkIds.includes(c.id));
  try {
    const lists = await Promise.all(cals.map((c) => gcal.listEvents(
      c.id, new Date(`${first}T00:00:00`), new Date(`${L.addDays(last, 1)}T00:00:00`))));
    const events = lists.flatMap((items, i) => items
      .map((ev) => L.normalizeEvent(ev, cals[i], { includeAllDay: true }))
      .filter(Boolean));
    const at = Date.now();
    for (let d = first; d <= last; d = L.addDays(d, 1)) {
      const ds = new Date(`${d}T00:00:00`);
      const de = new Date(`${L.addDays(d, 1)}T00:00:00`);
      state.dayCache.set(d, { at, events: events.filter((e) => e.start < de && e.end > ds) });
    }
  } catch (e) {
    if (seq === agendaLoadSeq) $('#agendaNote').textContent = `Couldn't load events: ${e.message}`;
    if (e instanceof gcal.AuthError) setSignedOut();
    return;
  }
  if (seq === agendaLoadSeq) renderAgenda();
}

/** Timed items (existing events + new blocks) for one day, with side-by-side lanes. */
function dayItems(date) {
  const events = state.dayCache.get(date)?.events || [];
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const toMin = (d) => Math.round((d.getTime() - dayStart) / 60000);
  const items = events.filter((e) => !e.allDay).map((e) => ({
    kind: 'event', ev: e, s: Math.max(0, toMin(e.start)), e: Math.min(24 * 60, toMin(e.end)),
  })).filter((i) => i.e > i.s);
  for (const r of state.rows) {
    if (!L.occursOn(r, date) || L.validateRow({ ...r, title: r.title || 'x' }).length) continue;
    items.push({ kind: 'draft', row: r, s: toMins(r.start), e: toMins(r.end) });
  }
  L.assignLanes(items);
  return { items, allDay: events.filter((e) => e.allDay) };
}

function allDayChip(e) {
  return h('span', { class: 'allday-chip', style: { '--c': e.color || 'var(--muted)' }, title: `${e.title} · ${e.calendarName}` }, e.title);
}

function blockEl(i, px) {
  const width = 100 / i.lanes;
  const style = {
    top: `${px(i.s)}px`,
    height: `${Math.max(px(i.e) - px(i.s) - 1, 14)}px`,
    left: `calc(${i.lane * width}% + 1px)`,
    width: `calc(${width}% - 2px)`,
  };
  const tall = i.e - i.s >= 30;
  if (i.kind === 'event') {
    style['--c'] = i.ev.color || 'var(--muted)';
    const time = `${fmtTime(i.ev.start)}–${fmtTime(i.ev.end)}`;
    return h('div', { class: 'blk', style, title: `${i.ev.title}\n${time} · ${i.ev.calendarName}` },
      h('b', {}, i.ev.title), tall ? h('span', { class: 'blk-time' }, time) : null);
  }
  const st = rowStatus(i.row).state;
  const dragging = drag?.moved && drag.rowId === i.row.id;
  const time = `${fmtHM(i.row.start)}–${fmtHM(i.row.end)}`;
  return h('div', {
    class: `blk draft${isTaskRow(i.row) ? ' task' : ''}${st === 'conflict' && !i.row.force ? ' conflict' : ''}${dragging ? ' dragging' : ''}`,
    style,
    'data-row-id': i.row.id,
    title: `${i.row.title || '(untitled)'}\n${time} · new ${isTaskRow(i.row) ? 'task' : 'block'}\nDrag to move · drag the bottom edge to resize`,
  },
  h('b', {}, i.row.title || '(untitled)'),
  tall || dragging ? h('span', { class: 'blk-time' }, time) : null,
  h('div', { class: 'grip' }));
}

function renderAgenda() {
  const dates = visibleDates();
  const week = dates.length > 1;
  const today = todayStr();
  for (const b of document.querySelectorAll('.view-toggle button')) {
    b.classList.toggle('active', b.dataset.view === state.view);
    b.setAttribute('aria-pressed', b.dataset.view === state.view);
  }
  $('#agendaTitle').textContent = week
    ? `${fmtDay(dates[0])} – ${fmtDay(dates[dates.length - 1])}`
    : dates[0] === today ? `Today · ${fmtDay(dates[0])}` : fmtDay(dates[0]);
  $('#agendaPrev').setAttribute('aria-label', week ? 'Previous week' : 'Previous day');
  $('#agendaNext').setAttribute('aria-label', week ? 'Next week' : 'Next day');
  $('#agendaNote').textContent = !state.signedIn ? 'Sign in to see your calendar here.'
    : dates.some((d) => !state.dayCache.has(d)) ? 'Loading…' : '';

  const cols = dates.map(dayItems);
  $('#agendaAllDay').replaceChildren(...(week ? [] : cols[0].allDay.map(allDayChip)));

  const ghost = drag?.mode === 'create' && drag.moved ? { ...drag, title: 'New block' } : taskGhost;
  let from = 8 * 60;
  let to = 24 * 60;
  for (const i of [...cols.flatMap((c) => c.items), ...(ghost ? [ghost] : [])]) {
    from = Math.min(from, i.s);
    to = Math.max(to, i.e);
  }
  from = Math.floor(from / 60) * 60;
  to = Math.min(24 * 60, Math.ceil(to / 60) * 60);
  const px = (m) => ((m - from) / 60) * hourPx();

  const tl = $('#timeline');
  tl.dataset.from = from;
  tl.classList.toggle('week', week);

  const head = week ? h('div', { class: 'tl-head', style: { gridTemplateColumns: gridCols(dates.length) } },
    dates.map((d, ci) => h('div', { class: `tl-dayhead${d === today ? ' today' : ''}`, 'data-date': d, title: 'Open this day' },
      h('div', { class: 'tl-daylabel' },
        h('span', { class: 'dow' }, WEEKDAY_SHORT[L.weekdayOf(d)]),
        h('span', { class: 'dom' }, String(Number(d.slice(8))))),
      h('div', { class: 'tl-allday' }, cols[ci].allDay.map(allDayChip))))) : null;

  const body = h('div', { class: 'tl-body', style: { height: `${px(to)}px` } });
  for (let m = from; m <= to; m += 60) {
    body.append(h('div', { class: 'hour', style: { top: `${px(m)}px` } },
      h('span', {}, `${String((m / 60) % 24).padStart(2, '0')}:00`)));
  }
  const colEls = dates.map((d, ci) => {
    const kids = cols[ci].items.map((i) => blockEl(i, px));
    if (d === today) {
      const now = new Date();
      const m = now.getHours() * 60 + now.getMinutes();
      if (m >= from && m <= to) kids.push(h('div', { class: 'now', style: { top: `${px(m)}px` } }));
    }
    if (ghost && ghost.date === d) {
      kids.push(h('div', {
        class: `blk ghost${ghost.task ? ' task' : ''}`,
        style: { top: `${px(ghost.s)}px`, height: `${Math.max(px(ghost.e) - px(ghost.s) - 1, 14)}px` },
      }, h('b', {}, ghost.title), h('span', { class: 'blk-time' }, `${toHM(ghost.s)}–${toHM(ghost.e)}`)));
    }
    return h('div', { class: `tl-col${d === today && week ? ' today' : ''}`, 'data-date': d }, kids);
  });
  body.append(h('div', { class: 'tl-cols', style: { gridTemplateColumns: gridCols(dates.length) } }, colEls));
  tl.replaceChildren(...[head, body].filter(Boolean));

  const legendCals = state.calendars.filter((c) => (state.checkIds || []).includes(c.id));
  $('#legend').replaceChildren(
    h('span', {}, h('span', { class: 'swatch draft-swatch' }), 'New blocks'),
    ...legendCals.map((c) => h('span', {}, h('span', { class: 'swatch', style: { background: c.color } }), c.name)),
  );
}

// ---------------------------------------------------------------- timeline drag

const SNAP = 15;
const DAY_END = 23 * 60 + 59;
const DRAG_THRESHOLD = 4; // px before a press becomes a drag
let drag = null; // {mode:'create'|'move'|'resize'|'tap', pointerId, date, startY, moved, rowId?, orig?, offset?, anchor?, s?, e?}

const hourPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 36;
const toMins = (t) => { const [hh, mm] = t.split(':').map(Number); return hh * 60 + mm; };
const toHM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snap = (m) => Math.round(m / SNAP) * SNAP;

/** Minutes since midnight under a viewport Y coordinate on the timeline. */
function minutesAt(clientY) {
  const tl = $('#timeline');
  const rect = tl.querySelector('.tl-body').getBoundingClientRect();
  return Number(tl.dataset.from) + ((clientY - rect.top) / hourPx()) * 60;
}

/** Date of the day column under a viewport X coordinate (nearest column when outside). */
function dateAt(clientX) {
  const cols = [...document.querySelectorAll('#timeline .tl-col')];
  let best = cols[0];
  for (const c of cols) if (clientX >= c.getBoundingClientRect().left) best = c;
  return best?.dataset.date;
}

/** Put a block on `date` from start to end, reusing the blank row if there is one. */
function addBlock(date, start, end, { title, taskId } = {}) {
  const fields = { date, start, end, cal: taskId ? 'tasks' : undefined, taskId };
  if (title) fields.title = title;
  let row = state.rows.find((r) => L.isBlank(r));
  if (row) Object.assign(row, fields);
  else {
    row = newRow(fields);
    state.rows.push(row);
  }
  rememberDuration(row);
  state.agendaDate = date;
  onRowsChanged();
  // renderRows leaves a focused input alone, so fill in a dropped task's title here.
  if (title) rowEls.get(row.id).querySelector('.f-title').value = row.title;
  focusRow(row.id);
}

function syncRowTimes(row) {
  const el = rowEls.get(row.id);
  if (!el) return;
  el.querySelector('.f-start').value = row.start;
  el.querySelector('.f-end').value = row.end;
  el.querySelector('.f-date').value = row.date;
}

function endDrag(tl, { cancel = false } = {}) {
  const d = drag;
  drag = null;
  tl.classList.remove('dragging');
  if (tl.hasPointerCapture?.(d.pointerId)) tl.releasePointerCapture(d.pointerId);
  const row = d.rowId && state.rows.find((r) => r.id === d.rowId);
  if (cancel && row && d.orig) {
    Object.assign(row, d.orig);
    syncRowTimes(row);
  }
  return { d, row };
}

function wireTimelineDrag() {
  const tl = $('#timeline');

  // Week view: clicking a day header opens that day.
  tl.addEventListener('click', (e) => {
    const head = e.target.closest('.tl-dayhead');
    if (!head) return;
    state.agendaDate = head.dataset.date;
    setView('day');
  });

  tl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag || !e.target.closest('.tl-body')) return;
    const m = minutesAt(e.clientY);
    const blk = e.target.closest('.blk.draft');
    const base = { pointerId: e.pointerId, date: dateAt(e.clientX), startX: e.clientX, startY: e.clientY, moved: false };
    if (blk) {
      const row = state.rows.find((r) => r.id === blk.dataset.rowId);
      if (!row) return;
      drag = {
        ...base,
        mode: e.target.closest('.grip') ? 'resize' : 'move',
        rowId: row.id,
        orig: { start: row.start, end: row.end, date: row.date },
        offset: m - toMins(row.start),
      };
    } else {
      // Touch on empty space: a tap adds a block, a swipe scrolls normally.
      drag = { ...base, mode: e.pointerType === 'touch' ? 'tap' : 'create', anchor: clamp(Math.floor(m / SNAP) * SNAP, 0, DAY_END - SNAP) };
      if (drag.mode === 'tap') return;
    }
    tl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  tl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.moved = true;
      if (drag.mode === 'tap') return; // the browser is scrolling
      tl.classList.add('dragging');
    }
    if (drag.mode === 'tap') return;
    // Auto-scroll near the edges.
    const rect = tl.getBoundingClientRect();
    if (e.clientY < rect.top + 24) tl.scrollTop -= 8;
    else if (e.clientY > rect.bottom - 24) tl.scrollTop += 8;

    const m = minutesAt(e.clientY);
    if (drag.mode === 'create') {
      const cur = clamp(snap(m), 0, DAY_END);
      const s = Math.min(drag.anchor, cur);
      let end = Math.max(drag.anchor, cur);
      if (cur <= drag.anchor) end = Math.min(drag.anchor + SNAP, DAY_END); // dragging upwards keeps the anchor slot
      if (end - s < SNAP) end = Math.min(s + SNAP, DAY_END);
      drag.s = s;
      drag.e = end;
    } else {
      const row = state.rows.find((r) => r.id === drag.rowId);
      if (!row) return;
      if (drag.mode === 'move') {
        const dur = toMins(drag.orig.end) - toMins(drag.orig.start);
        const s = clamp(snap(m - drag.offset), 0, DAY_END - dur);
        row.start = toHM(s);
        row.end = toHM(s + dur);
        // One-off blocks can also move across days in the week view; a series keeps its start date.
        if (!L.isRecurring(row)) row.date = dateAt(e.clientX) || row.date;
      } else {
        const s = toMins(row.start);
        row.end = toHM(clamp(snap(m), s + SNAP, DAY_END));
      }
      syncRowTimes(row);
    }
    renderAgenda();
  });

  tl.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { d, row } = endDrag(tl);
    if (!d.moved) {
      if (row) focusRow(row.id);
      else if (d.date) addBlock(d.date, toHM(d.anchor), L.addMinutes(toHM(d.anchor), DEFAULT_DURATION));
      return;
    }
    if (d.mode === 'create') addBlock(d.date, toHM(d.s), toHM(d.e));
    else if (row) {
      state.saveErrors.delete(row.id);
      rememberDuration(row);
      onRowsChanged({ structural: false });
    }
  });

  tl.addEventListener('pointercancel', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    endDrag(tl, { cancel: true });
    renderAgenda();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drag) return;
    endDrag(tl, { cancel: true });
    renderAgenda();
  });
}

// ---------------------------------------------------------------- task board

const LANES = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'waiting', label: 'Waiting' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' },
];
const OLD_WAIT_MS = 7 * 24 * 60 * 60_000; // waiting longer than this is highlighted
const lanesEl = $('#lanes');
let taskDrag = null; // {taskId, pointerId, startX, startY, moved, onTitle, title, chip, lane, index}
let taskGhost = null; // {date, s, e, title, task} while a task hovers over the calendar

const taskOf = (el) => state.tasks.find((t) => t.id === el.closest('.task-card')?.dataset.taskId);

/** The draft row a task was dropped into (not saved yet), if any. */
function draftForTask(task) {
  return state.rows.find((r) => r.taskId === task.id && r.date && HHMM.test(r.start) && HHMM.test(r.end));
}

function scheduledTag(task) {
  const row = draftForTask(task);
  if (row) {
    return h('button', { type: 'button', class: 'sched draft', 'data-row-id': row.id, title: 'Scheduled, not saved yet — click to show the block' },
      `${fmtDay(row.date)} ${row.start}`);
  }
  const s = task.scheduled;
  if (!s) return null;
  return h('a', { class: 'sched', href: s.link, target: '_blank', rel: 'noopener', title: 'Open in Google Calendar' },
    `${fmtDay(s.date)} ${s.start}`);
}

function taskCard(task) {
  const now = Date.now();
  const waiting = task.status === 'waiting';
  const old = waiting && task.waitingSince && now - task.waitingSince > OLD_WAIT_MS;
  return h('li', { class: `task-card${taskDrag?.moved && taskDrag.taskId === task.id ? ' dragging' : ''}`, 'data-task-id': task.id },
    h('span', { class: 'grip-dots', 'aria-hidden': 'true' }, '⋮⋮'),
    h('span', { class: 'task-title', title: 'Click to edit · drag to another lane or onto the calendar' }, task.title),
    waiting && task.waitingSince
      ? h('span', { class: `age${old ? ' old' : ''}`, title: `Waiting since ${new Date(task.waitingSince).toLocaleString()}` },
        L.waitingAge(task.waitingSince, now))
      : null,
    scheduledTag(task),
    h('button', { type: 'button', class: 'icon-btn t-remove', 'aria-label': 'Delete task', title: 'Delete task' }, '×'),
    waiting ? h('input', {
      type: 'text', class: 't-waiting-on', placeholder: 'waiting on…', value: task.waitingOn, 'aria-label': 'Waiting on', autocomplete: 'off',
    }) : null,
  );
}

function renderTasks() {
  // Don't rebuild under the user's cursor: while typing in a card, or mid-drag.
  if (taskDrag?.moved || (lanesEl.contains(document.activeElement) && document.activeElement.matches('input'))) return;
  lanesEl.replaceChildren(...LANES.map(({ status, label }) => {
    const tasks = state.tasks.filter((t) => t.status === status);
    const collapsed = status === 'done' && !state.showDone;
    const count = h('span', { class: 'count' }, String(tasks.length));
    return h('section', { class: `lane ${status}${collapsed ? ' collapsed' : ''}`, 'data-status': status },
      status === 'done'
        ? h('button', { type: 'button', class: 'lane-head toggle', 'aria-expanded': String(!collapsed) },
          h('span', {}, label), count, h('span', { class: 'caret' }, collapsed ? '▸' : '▾'))
        : h('div', { class: 'lane-head' }, h('span', {}, label), count),
      collapsed ? null : h('ol', { class: 'lane-list' }, tasks.map(taskCard)));
  }));
}

function addTask(title) {
  state.tasks.push({
    id: uid(), title, status: 'backlog', waitingOn: '', waitingSince: null,
    createdAt: Date.now(), doneAt: null, scheduled: null,
  });
  persistTasks();
  renderTasks();
}

function renameTask(task, title) {
  if (!title) {
    state.tasks = state.tasks.filter((t) => t !== task);
  } else if (title !== task.title) {
    // Unsaved blocks made from this task follow the new name.
    for (const r of state.rows) if (r.taskId === task.id && r.title === task.title) r.title = title;
    task.title = title;
    onRowsChanged();
  }
  persistTasks();
}

function editTaskTitle(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  const span = lanesEl.querySelector(`[data-task-id="${taskId}"] .task-title`);
  if (!task || !span) return;
  const input = h('input', { type: 'text', class: 't-title', value: task.title, 'aria-label': 'Task title', autocomplete: 'off' });
  span.replaceWith(input);
  input.focus();
  input.select();
}

/** Make sure the "Tasks" calendar is shown on the calendar and conflict-checked. */
function ensureTasksCalChecked() {
  if (!state.tasksCalId || !state.checkIds || state.checkIds.includes(state.tasksCalId)) return;
  state.checkIds = state.calendars.map((c) => c.id).filter((id) => id === state.tasksCalId || state.checkIds.includes(id));
  persistSettings();
  state.dayCache.clear();
  renderSettings();
  loadAgendaDay();
}

function clearLaneMarks() {
  lanesEl.querySelectorAll('.drop-line').forEach((el) => el.remove());
  lanesEl.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
}

const autoScroll = (el, y) => {
  const rect = el.getBoundingClientRect();
  if (y < rect.top + 24) el.scrollTop -= 8;
  else if (y > rect.bottom - 24) el.scrollTop += 8;
};

/** Work out where a dragged task would land: a spot on the calendar, or a position in a lane. */
function updateTaskDrop(e) {
  const d = taskDrag;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  clearLaneMarks();
  d.lane = null;
  if (under?.closest('#timeline .tl-body')) {
    autoScroll($('#timeline'), e.clientY);
    const s = clamp(Math.floor(minutesAt(e.clientY) / SNAP) * SNAP, 0, Math.floor((DAY_END - TASK_DURATION) / SNAP) * SNAP);
    const date = dateAt(e.clientX);
    if (!taskGhost || taskGhost.s !== s || taskGhost.date !== date) {
      taskGhost = { date, s, e: s + TASK_DURATION, title: d.title, task: true };
      renderAgenda();
    }
    return;
  }
  if (taskGhost) { taskGhost = null; renderAgenda(); }
  const lane = under?.closest('.lane');
  if (!lane || !lanesEl.contains(lane)) return;
  autoScroll(lanesEl, e.clientY);
  lane.classList.add('drop-target');
  d.lane = lane.dataset.status;
  const list = lane.querySelector('.lane-list');
  if (!list) { d.index = 0; return; }
  const cards = [...list.querySelectorAll('.task-card')].filter((c) => c.dataset.taskId !== d.taskId);
  d.index = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2 < e.clientY; }).length;
  list.insertBefore(h('li', { class: 'drop-line', 'aria-hidden': 'true' }), cards[d.index] || null);
}

function endTaskDrag() {
  const d = taskDrag;
  taskDrag = null;
  if (lanesEl.hasPointerCapture?.(d.pointerId)) lanesEl.releasePointerCapture(d.pointerId);
  d.chip?.remove();
  document.body.classList.remove('task-dragging');
  clearLaneMarks();
  if (taskGhost) { taskGhost = null; renderAgenda(); }
  if (d.moved) renderTasks();
  return d;
}

function wireTasks() {
  $('#newTask').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const title = e.target.value.trim();
    if (!title) return;
    e.target.value = '';
    addTask(title);
  });

  lanesEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || taskDrag || drag) return;
    const card = e.target.closest('.task-card');
    if (!card || e.target.closest('input, button, a')) return;
    if (e.pointerType === 'touch' && !e.target.closest('.grip-dots')) return; // touch elsewhere scrolls
    taskDrag = {
      taskId: card.dataset.taskId, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      moved: false, onTitle: !!e.target.closest('.task-title'),
    };
    lanesEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  lanesEl.addEventListener('pointermove', (e) => {
    const d = taskDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.moved = true;
      d.title = state.tasks.find((t) => t.id === d.taskId)?.title || '';
      d.chip = h('div', { class: 'task-chip' }, d.title);
      document.body.append(d.chip);
      document.body.classList.add('task-dragging');
      lanesEl.querySelector(`[data-task-id="${d.taskId}"]`)?.classList.add('dragging');
    }
    d.chip.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
    updateTaskDrop(e);
  });

  lanesEl.addEventListener('pointerup', (e) => {
    if (!taskDrag || e.pointerId !== taskDrag.pointerId) return;
    if (taskDrag.moved) updateTaskDrop(e); // land exactly where the pointer was released
    const ghost = taskGhost;
    const d = endTaskDrag();
    if (!d.moved) {
      if (d.onTitle) editTaskTitle(d.taskId);
      return;
    }
    const task = state.tasks.find((t) => t.id === d.taskId);
    if (!task) return;
    if (ghost) {
      addBlock(ghost.date, toHM(ghost.s), toHM(ghost.e), { title: task.title, taskId: task.id });
      ensureTasksCalChecked();
    } else if (d.lane) {
      state.tasks = L.moveTask(state.tasks, task.id, d.lane, d.index, Date.now());
      persistTasks();
      renderTasks();
    }
  });

  lanesEl.addEventListener('pointercancel', (e) => {
    if (taskDrag && e.pointerId === taskDrag.pointerId) endTaskDrag();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && taskDrag) endTaskDrag();
  });

  lanesEl.addEventListener('click', (e) => {
    if (e.target.closest('.lane-head.toggle')) {
      state.showDone = !state.showDone;
      persistSettings();
      renderTasks();
      return;
    }
    const task = taskOf(e.target);
    if (!task) return;
    if (e.target.closest('.t-remove')) {
      state.tasks = state.tasks.filter((t) => t !== task);
      persistTasks();
      renderTasks();
    } else if (e.target.closest('.sched.draft')) {
      const row = draftForTask(task);
      if (row) focusRow(row.id);
    }
  });

  lanesEl.addEventListener('input', (e) => {
    if (!e.target.classList.contains('t-waiting-on')) return;
    const task = taskOf(e.target);
    if (!task) return;
    task.waitingOn = e.target.value;
    persistTasks();
  });

  lanesEl.addEventListener('keydown', (e) => {
    if (!e.target.matches('.t-title, .t-waiting-on')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape' && e.target.classList.contains('t-title')) {
      e.target.dataset.cancel = '1';
      e.target.blur();
    }
  });

  lanesEl.addEventListener('focusout', (e) => {
    const t = e.target;
    if (t.classList.contains('t-title') && !t.dataset.cancel) {
      const task = taskOf(t);
      if (task) renameTask(task, t.value.trim());
    }
    setTimeout(renderTasks, 0);
  });
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
  renderTasks();
  scheduleAutoCheck();
}

function scheduleAutoCheck() {
  clearTimeout(autoCheckTimer);
  if (!state.signedIn || isFresh() || drag) return;
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
  if (saveableRows().some((r) => !rowCalendar(r))) {
    flash('bad', 'Choose a calendar to save to under ⚙ Save to.');
    $('#settings').open = true;
    return;
  }
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
    const cals = rows.map(rowCalendar);
    const res = await gcal.mapLimit(rows, 3, (row, i) => gcal.insertEvent(cals[i].id, L.buildEventPayload(row, TZ)));
    const saved = [];
    res.forEach((r, i) => {
      if (r.ok) {
        saved.push({
          calendarId: cals[i].id, calendarName: cals[i].name, eventId: r.value.id, link: r.value.htmlLink,
          row: { ...rows[i], repeat: { ...rows[i].repeat, days: [...rows[i].repeat.days] } },
        });
      }
      else state.saveErrors.set(rows[i].id, r.error.message);
    });
    for (const s of saved) {
      const task = s.row.taskId && state.tasks.find((t) => t.id === s.row.taskId);
      if (task) task.scheduled = { date: L.firstOccurrence(s.row), start: s.row.start, end: s.row.end, link: s.link, eventId: s.eventId };
    }
    persistTasks();
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
        h('span', {}, `Saved ${plural(saved.length, 'block')} to ${[...new Set(saved.map((s) => s.calendarName))].join(' and ')}.`),
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
  for (const s of restored) {
    const task = s.row.taskId && state.tasks.find((t) => t.id === s.row.taskId);
    if (task?.scheduled?.eventId === s.eventId) task.scheduled = null;
  }
  persistTasks();
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
  state.tasksCalId = state.calendars.find((c) => c.name?.trim().toLowerCase() === TASKS_CALENDAR_NAME.toLowerCase())?.id || null;
  const known = new Set(state.calendars.map((c) => c.id));
  if (!state.checkIds) state.checkIds = [primary?.id, state.targetId, state.tasksCalId].filter(Boolean);
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
  const view = params.get('view');
  if (view && view !== state.view) setView(view);
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('#defaultDate').addEventListener('change', (e) => setDefaultDate(e.target.value));
  $('#prevDay').addEventListener('click', () => setDefaultDate(L.addDays(state.defaultDate, -1)));
  $('#nextDay').addEventListener('click', () => setDefaultDate(L.addDays(state.defaultDate, 1)));
  $('#todayBtn').addEventListener('click', () => setDefaultDate(todayStr()));
  $('#tomorrowBtn').addEventListener('click', () => setDefaultDate(L.addDays(todayStr(), 1)));

  const stepAgenda = (dir) => {
    state.agendaDate = L.addDays(agendaDate(), dir * (state.view === 'week' ? 7 : 1));
    loadAgendaDay();
  };
  $('#agendaPrev').addEventListener('click', () => stepAgenda(-1));
  $('#agendaNext').addEventListener('click', () => stepAgenda(1));
  for (const b of document.querySelectorAll('.view-toggle button')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }

  wireTimelineDrag();
  wireTasks();

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
  setInterval(() => { renderAgenda(); renderTasks(); }, 5 * 60_000);
}

async function main() {
  // Panels fill the screen below the (sticky, possibly wrapping) top bar.
  const topbar = $('.topbar');
  new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);
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
