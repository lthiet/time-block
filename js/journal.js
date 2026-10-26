// Habits (daily check-ins with a heatmap) and the distraction log, shown as tabs next to the task board.
// Both sync through their own file in the app's Google Drive folder, the same way tasks do.
import * as auth from './auth.js';
import * as gcal from './gcal.js';
import * as drive from './drive.js';
import * as L from './logic.js?v=23'; // bump with app.js?v= in index.html

const $ = (sel) => document.querySelector(sel);
const HABITS_KEY = 'tb.habits';
const DISTRACTIONS_KEY = 'tb.distractions';
const SHORTCUT_KEY = 'tb.captureKey';
const HABIT_KIND_KEY = 'tb.habitKind';
const SYNC_DEBOUNCE = 1500;
const HEATMAP_WEEKS = 26;

export const IS_MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '');

let deps; // {h, flash, plural, fmtDay, fmtTime, todayStr, uid, isSignedIn, onSyncStatus, onAuthError}

// ---------------------------------------------------------------- stores

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function cleanHabits(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && x.id).map((x) => {
    const checks = {};
    for (const [d, c] of Object.entries(isObj(x.checks) ? x.checks : {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && isObj(c)) checks[d] = { on: !!c.on, at: Number(c.at) || 0 };
    }
    const createdAt = Number(x.createdAt) || Date.now();
    return {
      id: String(x.id), title: String(x.title || ''), kind: x.kind === 'avoid' ? 'avoid' : 'do',
      checks, createdAt, updatedAt: Number(x.updatedAt) || 0,
      start: /^\d{4}-\d{2}-\d{2}$/.test(x.start || '') ? x.start : L.ymd(new Date(createdAt)),
    };
  });
}

function cleanDistractions(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && x.id).map((x) => ({
    id: String(x.id), text: String(x.text || ''), at: Number(x.at) || Date.now(), done: !!x.done,
    note: String(x.note || ''), updatedAt: Number(x.updatedAt) || 0,
  }));
}

/** A list of records kept in localStorage and in `file` on Drive, merged per record like the task board. */
function createStore({ key, file, clean, combine, render }) {
  const st = { items: [], deleted: {}, saved: [], status: 'off', error: '', timer: null, running: null, again: false };
  const docKey = (d) => JSON.stringify([d.items, d.deleted]);
  const doc = () => ({ items: st.items, deleted: st.deleted });

  function saveLocal() {
    st.saved = st.items;
    try {
      localStorage.setItem(key, JSON.stringify(doc()));
    } catch { /* ignore */ }
  }

  function setStatus(status, error = '') {
    st.status = status;
    st.error = error;
    deps.onSyncStatus();
  }

  async function sync() {
    clearTimeout(st.timer);
    if (!deps.isSignedIn() || !auth.isSignedIn()) return;
    if (!auth.hasScope(auth.DRIVE_SCOPE)) { setStatus('noscope'); return; }
    if (st.running) { st.again = true; return; }
    st.running = (async () => {
      setStatus('syncing');
      const files = await drive.readTaskFiles(file);
      const remotes = files.filter((f) => f.doc).map((f) => ({ items: clean(f.doc.items), deleted: isObj(f.doc.deleted) ? f.doc.deleted : {} }));
      // Merge against the list as it is now, after the download (no await between here and the save).
      const merged = remotes.reduce((acc, r) => L.mergeRecordDocs(acc, r, Date.now(), combine), doc());
      if (docKey(merged) !== docKey(doc())) {
        st.items = merged.items;
        st.deleted = merged.deleted;
        saveLocal();
        render();
      }
      const out = { version: 1, ...merged };
      if (files.length !== 1 || !files[0].doc || docKey(files[0].doc) !== docKey(out)) {
        await drive.writeTaskFile(files[0]?.id || null, out, file);
      }
      await Promise.all(files.slice(1).map((f) => drive.deleteTaskFile(f.id).catch(() => {})));
      setStatus('ok');
    })();
    try {
      await st.running;
    } catch (e) {
      if (e instanceof drive.ScopeError) setStatus('noscope');
      else setStatus('error', e.message);
      if (e instanceof gcal.AuthError) deps.onAuthError();
    } finally {
      st.running = null;
    }
    if (st.again) {
      st.again = false;
      sync();
    }
  }

  return {
    st,
    get items() { return st.items; },
    set items(v) { st.items = v; },
    load() {
      try {
        const d = JSON.parse(localStorage.getItem(key) || 'null');
        st.items = clean(d?.items);
        st.deleted = isObj(d?.deleted) ? d.deleted : {};
      } catch { /* ignore */ }
      st.saved = st.items;
    },
    /** Save after a local edit and queue a sync. */
    persist() {
      const now = Date.now();
      const { tasks, removed } = L.stampTaskChanges(st.saved, st.items, now);
      st.items = tasks;
      for (const id of removed) st.deleted[id] = now;
      saveLocal();
      clearTimeout(st.timer);
      st.timer = setTimeout(sync, SYNC_DEBOUNCE);
    },
    sync,
  };
}

const habits = createStore({ key: HABITS_KEY, file: 'habits.json', clean: cleanHabits, combine: L.mergeHabit, render: () => renderHabits() });
const distractions = createStore({ key: DISTRACTIONS_KEY, file: 'distractions.json', clean: cleanDistractions, render: () => renderDistractions() });

export const stores = () => [habits.st, distractions.st];
export const syncAll = () => Promise.all([habits.sync(), distractions.sync()]);

// ---------------------------------------------------------------- habits

const habitsEl = () => $('#habitList');
const STATE_LABEL = {
  do: { done: 'checked in', broken: 'broken', pending: 'not checked in yet', before: 'before this habit started', future: '' },
  avoid: { done: 'kept', broken: 'slipped', pending: 'no slip yet', before: 'before this habit started', future: '' },
};
let focusedHabit = null; // habit id shown alone on the heatmap, or null for all habits
let newKind = 'do'; // kind given to the next habit added

function setNewKind(kind) {
  newKind = kind === 'avoid' ? 'avoid' : 'do';
  for (const b of document.querySelectorAll('#newHabitKind button')) {
    const on = b.dataset.kind === newKind;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('#newHabit').placeholder = newKind === 'avoid' ? '+ Add a habit to avoid (Enter)' : '+ Add a habit (Enter)';
}

/** One cell per day for a single habit; yesterday and today can be toggled. */
function habitCell(habit, date, today) {
  const s = L.habitDayState(habit, date, today);
  const can = L.canToggleDay(habit, date, today);
  return deps.h('span', {
    class: `hm-cell ${s}${date === today ? ' today' : ''}${can ? ' can' : ''}`,
    'data-date': date,
    title: s === 'future' ? null : `${deps.fmtDay(date)} · ${STATE_LABEL[habit.kind || 'do'][s]}${can ? ' · click to toggle' : ''}`,
  });
}

/** One cell per day across all habits: red gets stronger the more habits were broken that day. */
function combinedCell(list, date, today) {
  const { h, fmtDay } = deps;
  const d = L.combinedDayState(list, date, today);
  let title = null;
  if (d.state !== 'future' && d.state !== 'before') {
    title = `${fmtDay(date)} · ${d.done} of ${d.total} kept`;
    if (d.broken.length) title += ` · broken: ${d.broken.map((x) => x.title).join(', ')}`;
  }
  const k = d.state === 'broken' ? d.broken.length / d.total : d.state === 'pending' ? d.done / d.total : 1;
  return h('span', { class: `hm-cell ${d.state}${date === today ? ' today' : ''}`, style: { '--k': k.toFixed(2) }, title });
}

function renderHeatmap(list, today) {
  const { h } = deps;
  const focus = list.find((x) => x.id === focusedHabit);
  const cells = L.heatmapWeeks(today, HEATMAP_WEEKS).flat()
    .map((date) => (focus ? habitCell(focus, date, today) : combinedCell(list, date, today)));
  $('#habitMap').replaceChildren(h('div', { class: 'heatmap', style: { '--weeks': HEATMAP_WEEKS } }, cells));
  $('#habitMap').dataset.id = focus?.id || '';
  $('#habitMapLabel').replaceChildren(focus
    ? h('span', {}, h('strong', {}, focus.title), ' · click yesterday or today to fix a check-in · ',
      h('button', { type: 'button', class: 'linkish', id: 'habitMapAll' }, 'show all habits'))
    : h('span', {}, 'All habits · click a habit to see only its days'));
  $('#habitMapWrap').hidden = !list.length;
}

function habitRow(habit, today) {
  const { h, plural } = deps;
  const stats = L.habitStats(habit, today);
  const ticked = L.isChecked(habit, today);
  const avoid = L.isAvoid(habit);
  const focused = habit.id === focusedHabit;
  let tickTitle = ticked ? 'Checked in today · click to undo' : 'Check in for today';
  if (avoid) tickTitle = ticked ? 'Slipped today · click to undo' : 'Mark today as slipped';
  return h('li', {
    class: `habit${avoid ? ' avoid' : ''}${ticked && !avoid ? ' done-today' : ''}${focused ? ' focused' : ''}`, 'data-id': habit.id,
    title: focused ? 'Click to show all habits' : 'Click to show only this habit on the heatmap',
  },
  h('button', { type: 'button', class: `h-check${ticked ? ' on' : ''}`, 'aria-pressed': String(ticked), title: tickTitle }, avoid ? '✗' : '✓'),
  h('span', { class: 'h-title', title: 'Double-click to rename' }, habit.title),
  h('button', {
    type: 'button', class: 'h-kind',
    title: avoid ? 'Avoid: tick the days you slip · click to make it a habit to do' : 'Do: tick the days you do it · click to make it a habit to avoid',
  }, avoid ? 'avoid' : 'do'),
  h('span', { class: 'h-stat streak', title: `Current streak: ${plural(stats.current, 'day')}` }, `${stats.current}d`),
  h('span', { class: 'h-stat', title: `Best streak: ${plural(stats.best, 'day')}` }, `best ${stats.best}`),
  h('span', { class: `h-stat${stats.broken ? ' broken' : ''}`, title: `${plural(stats.broken, 'day')} broken` }, `${stats.broken}✗`),
  h('button', { type: 'button', class: 'icon-btn h-remove', 'aria-label': 'Delete habit', title: 'Delete habit' }, '×'));
}

export function renderHabits() {
  const el = habitsEl();
  if (el.contains(document.activeElement) && document.activeElement.matches('input')) return; // mid-rename
  const today = deps.todayStr();
  const list = [...habits.items].sort((a, b) => a.createdAt - b.createdAt);
  if (!list.some((x) => x.id === focusedHabit)) focusedHabit = null;
  renderHeatmap(list, today);
  el.replaceChildren(...list.map((x) => habitRow(x, today)));
  $('#habitsEmpty').hidden = list.length > 0;
  const open = list.filter((x) => !L.isAvoid(x) && !L.isChecked(x, today)).length;
  $('#habitsBadge').textContent = open ? String(open) : '';
  $('#habitsBadge').title = open ? `${deps.plural(open, 'habit')} not checked in today` : '';
}

function updateHabit(id, fn) {
  habits.items = habits.items.map((x) => (x.id === id ? fn(x) : x));
  habits.persist();
  renderHabits();
}

function wireHabits() {
  const { h } = deps;
  $('#newHabit').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const title = e.target.value.trim();
    if (!title) return;
    e.target.value = '';
    const now = Date.now();
    habits.items = [...habits.items, { id: deps.uid(), title, kind: newKind, start: deps.todayStr(), checks: {}, createdAt: now }];
    habits.persist();
    renderHabits();
  });
  $('#newHabitKind').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    setNewKind(b.dataset.kind);
    try {
      localStorage.setItem(HABIT_KIND_KEY, newKind);
    } catch { /* ignore */ }
  });
  let savedKind = null;
  try {
    savedKind = localStorage.getItem(HABIT_KIND_KEY);
  } catch { /* ignore */ }
  setNewKind(savedKind);

  $('#habitMapWrap').addEventListener('click', (e) => {
    if (e.target.closest('#habitMapAll')) {
      focusedHabit = null;
      renderHabits();
      return;
    }
    const cell = e.target.closest('.hm-cell.can');
    const id = $('#habitMap').dataset.id;
    if (cell && id) updateHabit(id, (x) => L.toggleCheck(x, cell.dataset.date, Date.now()));
  });

  habitsEl().addEventListener('click', (e) => {
    const row = e.target.closest('.habit');
    if (!row || e.target.closest('input')) return;
    const habit = habits.items.find((x) => x.id === row.dataset.id);
    if (!habit) return;
    if (e.target.closest('.h-check')) {
      updateHabit(habit.id, (x) => L.toggleCheck(x, deps.todayStr(), Date.now()));
    } else if (e.target.closest('.h-kind')) {
      const kind = L.isAvoid(habit) ? 'do' : 'avoid';
      const how = kind === 'avoid' ? 'Ticked days will count as slips and unticked days as kept.'
        : 'Ticked days will count as kept and unticked days as broken.';
      if (!confirm(`Make “${habit.title}” a habit to ${kind}? ${how}`)) return;
      updateHabit(habit.id, (x) => ({ ...x, kind }));
    } else if (e.target.closest('.h-remove')) {
      if (!confirm(`Delete the habit “${habit.title}” and its history?`)) return;
      habits.items = habits.items.filter((x) => x.id !== habit.id);
      habits.persist();
      renderHabits();
    } else {
      focusedHabit = focusedHabit === habit.id ? null : habit.id;
      renderHabits();
    }
  });
  habitsEl().addEventListener('dblclick', (e) => {
    const span = e.target.closest('.h-title');
    if (!span) return;
    const habit = habits.items.find((x) => x.id === span.closest('.habit').dataset.id);
    const input = h('input', { type: 'text', class: 'h-title-input', value: habit.title, 'aria-label': 'Habit name', autocomplete: 'off' });
    span.replaceWith(input);
    input.focus();
    input.select();
  });
  habitsEl().addEventListener('keydown', (e) => {
    if (!e.target.matches('.h-title-input')) return;
    if (e.key === 'Enter') e.target.blur();
    else if (e.key === 'Escape') { e.target.dataset.cancel = '1'; e.target.blur(); }
  });
  habitsEl().addEventListener('focusout', (e) => {
    if (!e.target.matches('.h-title-input')) return;
    const id = e.target.closest('.habit').dataset.id;
    const title = e.target.value.trim();
    e.target.blur();
    if (e.target.dataset.cancel || !title) {
      setTimeout(renderHabits);
      return;
    }
    setTimeout(() => updateHabit(id, (x) => ({ ...x, title })));
  });
}

// ---------------------------------------------------------------- distractions

const distEl = () => $('#distList');
let showDoneDistractions = false;
let showDistHistory = false;
let historyDay = null; // past day picked on the history heatmap, or null for all days
let editingNote = null; // entry id whose note input is open

function logDistraction(text) {
  distractions.items = [...distractions.items, { id: deps.uid(), text, at: Date.now(), done: false, note: '' }];
  distractions.persist();
  renderDistractions();
}

function distItem(e) {
  const { h, fmtTime } = deps;
  return h('li', { class: `dist${e.done ? ' done' : ''}`, 'data-id': e.id },
    h('input', { type: 'checkbox', class: 'd-done', checked: e.done, 'aria-label': 'Looked into it', title: e.done ? 'Mark as open' : 'Looked into it / let it go' }),
    h('time', { class: 'd-time', datetime: new Date(e.at).toISOString() }, fmtTime(new Date(e.at))),
    h('span', { class: 'd-text' }, e.text),
    h('button', { type: 'button', class: 'icon-btn d-note-btn', 'aria-label': 'Add a note', title: e.note ? 'Edit note' : 'Add a note (e.g. the answer)' }, '✎'),
    h('button', { type: 'button', class: 'icon-btn d-remove', 'aria-label': 'Delete', title: 'Delete' }, '×'),
    editingNote === e.id
      ? h('input', { type: 'text', class: 'd-note-input', value: e.note, placeholder: 'Note or answer (Enter)', 'aria-label': 'Note', autocomplete: 'off' })
      : e.note ? h('div', { class: 'd-note' }, e.note) : null);
}

function dayGroups(entries) {
  const { h, fmtDay, todayStr } = deps;
  return L.groupByDay(entries).map(({ date, items }) => h('section', { class: 'dist-day' },
    h('div', { class: 'dist-day-head' }, h('span', {}, date === todayStr() ? 'Today' : fmtDay(date)), h('span', { class: 'count' }, String(items.length))),
    h('ol', { class: 'dist-items' }, items.map(distItem))));
}

/** Triggers per day over the last weeks; busier days are darker. Click a day to show only that day. */
function distHeatmap(entries, today) {
  const { h, fmtDay, plural } = deps;
  const counts = L.countByDay(entries);
  const max = Math.max(1, ...Object.values(counts));
  const cells = L.heatmapWeeks(today, HEATMAP_WEEKS).flat().map((date) => {
    if (date > today) return h('span', { class: 'hm-cell future' });
    const n = counts[date] || 0;
    const past = date < today && n;
    return h('span', {
      class: `hm-cell dist-cell${n ? '' : ' zero'}${date === today ? ' today' : ''}${past ? ' can' : ''}${date === historyDay ? ' picked' : ''}`,
      'data-date': past ? date : null,
      style: { '--k': (n / max).toFixed(2) },
      title: `${fmtDay(date)} · ${plural(n, 'trigger')}${past ? (date === historyDay ? ' · click to show all days' : ' · click to show this day') : ''}`,
    });
  });
  return h('div', { class: 'heatmap', style: { '--weeks': HEATMAP_WEEKS } }, cells);
}

/** Today's entries in the list; earlier days live under History, so the panel starts fresh each day. */
export function renderDistractions() {
  const { h, plural } = deps;
  const el = distEl();
  if (el.contains(document.activeElement) && document.activeElement.matches('input[type=text]')) return;
  const today = deps.todayStr();
  const todays = distractions.items.filter((e) => L.ymd(new Date(e.at)) === today);
  const past = distractions.items.filter((e) => L.ymd(new Date(e.at)) !== today);
  const open = todays.filter((e) => !e.done);
  const done = todays.filter((e) => e.done);
  if (historyDay && !past.some((e) => L.ymd(new Date(e.at)) === historyDay)) historyDay = null;
  const shown = historyDay ? past.filter((e) => L.ymd(new Date(e.at)) === historyDay) : past;
  $('#distStats').textContent = `${plural(todays.length, 'trigger')} today · ${open.length} open`;
  el.replaceChildren(...[
    ...dayGroups(open),
    open.length ? null : h('p', { class: 'muted small empty' }, done.length ? 'Nothing open. Nice.' : 'Nothing logged today.'),
    done.length ? h('button', { type: 'button', class: 'lane-head toggle dist-done-toggle', 'aria-expanded': String(showDoneDistractions) },
      h('span', {}, 'Done'), h('span', { class: 'count' }, String(done.length)), h('span', { class: 'caret' }, showDoneDistractions ? '▾' : '▸')) : null,
    ...(showDoneDistractions ? dayGroups(done) : []),
    past.length ? h('button', { type: 'button', class: 'lane-head toggle dist-history-toggle', 'aria-expanded': String(showDistHistory) },
      h('span', {}, 'History'), h('span', { class: 'count' }, String(past.length)), h('span', { class: 'caret' }, showDistHistory ? '▾' : '▸')) : null,
    showDistHistory && past.length ? h('div', { class: 'dist-history' },
      distHeatmap(distractions.items, today),
      h('div', { class: 'muted small' }, historyDay
        ? h('span', {}, `${deps.fmtDay(historyDay)} · `, h('button', { type: 'button', class: 'linkish dist-history-all' }, 'show all days'))
        : 'Triggers per day · click a day to see only that day')) : null,
    ...(showDistHistory ? dayGroups(shown) : []),
  ].filter(Boolean));
  $('#distBadge').textContent = open.length ? String(open.length) : '';
  el.querySelector('.d-note-input')?.focus();
}

function updateEntry(id, patch) {
  distractions.items = distractions.items.map((x) => (x.id === id ? { ...x, ...patch } : x));
  distractions.persist();
}

function wireDistractions() {
  $('#newDistraction').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text) return;
    e.target.value = '';
    logDistraction(text);
  });
  distEl().addEventListener('click', (e) => {
    if (e.target.closest('.dist-done-toggle')) {
      showDoneDistractions = !showDoneDistractions;
      renderDistractions();
      return;
    }
    if (e.target.closest('.dist-history-toggle')) {
      showDistHistory = !showDistHistory;
      renderDistractions();
      return;
    }
    const cell = e.target.closest('.hm-cell[data-date]');
    if (cell || e.target.closest('.dist-history-all')) {
      historyDay = cell && cell.dataset.date !== historyDay ? cell.dataset.date : null;
      renderDistractions();
      return;
    }
    const li = e.target.closest('.dist');
    if (!li) return;
    if (e.target.closest('.d-remove')) {
      distractions.items = distractions.items.filter((x) => x.id !== li.dataset.id);
      distractions.persist();
      renderDistractions();
    } else if (e.target.closest('.d-note-btn, .d-note')) {
      editingNote = li.dataset.id;
      renderDistractions();
    }
  });
  distEl().addEventListener('change', (e) => {
    if (!e.target.matches('.d-done')) return;
    updateEntry(e.target.closest('.dist').dataset.id, { done: e.target.checked });
    renderDistractions();
  });
  distEl().addEventListener('keydown', (e) => {
    if (!e.target.matches('.d-note-input')) return;
    if (e.key === 'Enter') e.target.blur();
    else if (e.key === 'Escape') { e.target.dataset.cancel = '1'; e.target.blur(); }
  });
  distEl().addEventListener('focusout', (e) => {
    if (!e.target.matches('.d-note-input')) return;
    const id = e.target.closest('.dist').dataset.id;
    if (!e.target.dataset.cancel) updateEntry(id, { note: e.target.value.trim() });
    editingNote = null;
    setTimeout(renderDistractions);
  });
}

// ---------------------------------------------------------------- capture shortcut & popup

let captureCombo = L.defaultCaptureCombo(IS_MAC);
let recording = false;
let returnFocus = null;

function loadShortcut() {
  try {
    const saved = localStorage.getItem(SHORTCUT_KEY);
    if (saved && !L.shortcutProblem(saved)) captureCombo = saved;
  } catch { /* ignore */ }
}

function renderShortcut() {
  const label = L.formatCombo(captureCombo, IS_MAC);
  for (const el of document.querySelectorAll('.capture-key')) el.textContent = label;
  const btn = $('#shortcutBtn');
  btn.textContent = recording ? 'Press the new shortcut… (Esc cancels)' : 'Change';
  btn.classList.toggle('recording', recording);
  $('#shortcutReset').hidden = recording || captureCombo === L.defaultCaptureCombo(IS_MAC);
}

function setShortcut(combo) {
  captureCombo = combo;
  try {
    if (combo === L.defaultCaptureCombo(IS_MAC)) localStorage.removeItem(SHORTCUT_KEY);
    else localStorage.setItem(SHORTCUT_KEY, combo);
  } catch { /* ignore */ }
  renderShortcut();
}

const isEditable = (el) => el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));

export function openCapture() {
  const box = $('#capture');
  if (!box.hidden) { $('#captureInput').focus(); return; }
  returnFocus = document.activeElement;
  box.hidden = false;
  $('#captureInput').value = '';
  $('#captureNote').textContent = '';
  $('#captureInput').focus();
}

function closeCapture() {
  $('#capture').hidden = true;
  if (returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}

function wireCapture() {
  // Capture phase: the shortcut works whatever has focus, before any other key handler sees it.
  window.addEventListener('keydown', (e) => {
    if (e.repeat && !recording) return;
    if (recording) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { recording = false; renderShortcut(); return; }
      const combo = L.comboFromEvent(e);
      if (!combo) return; // still holding modifiers
      const problem = L.shortcutProblem(combo);
      if (problem) {
        $('#shortcutNote').textContent = `${L.formatCombo(combo, IS_MAC)}: ${problem}`;
        return;
      }
      recording = false;
      $('#shortcutNote').textContent = '';
      setShortcut(combo);
      return;
    }
    const combo = L.comboFromEvent(e);
    const plainKey = combo === 'G' && !isEditable(e.target); // quick trigger when not typing
    if (combo === captureCombo || plainKey) {
      e.preventDefault(); // the browser's own meaning of the combo (e.g. Find previous)
      e.stopPropagation();
      openCapture();
    }
  }, true);

  $('#captureInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCapture();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const text = e.target.value.trim();
      if (!text) { closeCapture(); return; }
      logDistraction(text);
      e.target.value = '';
      $('#captureNote').textContent = 'Logged. Back to work.';
      setTimeout(() => { if ($('#captureNote').textContent.startsWith('Logged')) closeCapture(); }, 450);
    }
  });
  $('#capture').addEventListener('mousedown', (e) => { if (e.target.id === 'capture') closeCapture(); });

  $('#shortcutBtn').addEventListener('click', () => {
    recording = !recording;
    $('#shortcutNote').textContent = '';
    renderShortcut();
  });
  $('#shortcutReset').addEventListener('click', () => {
    $('#shortcutNote').textContent = '';
    setShortcut(L.defaultCaptureCombo(IS_MAC));
  });
}

// ---------------------------------------------------------------- init

export function render() {
  renderHabits();
  renderDistractions();
}

export function init(d) {
  deps = d;
  habits.load();
  distractions.load();
  loadShortcut();
  wireHabits();
  wireDistractions();
  wireCapture();
  renderShortcut();
  render();
}
