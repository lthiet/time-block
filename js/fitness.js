// The Fitness section, ported from Iron Log: split-day lifting log, progress charts and body weight.
// Programs, sessions and weigh-ins sync through their own files in the app's Google Drive folder,
// with the same per-record store as habits.
import { IRON_LOG_FIREBASE } from '../config.js';
import { createStore } from './journal.js?v=26'; // must match app.js's import, so both share one module
import * as F from './fitness-logic.js?v=1';

const $ = (sel) => document.querySelector(sel);
const SECTION_KEY = 'tb.section';
const RANGE_KEY = 'tb.fitRange';
const DRAFT_KEY = 'tb.fitDraft';
const IMPORTED_KEY = 'tb.ironImported';
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const BLANK_SETS = 3;

let deps; // {h, todayStr, plural, fmtDay}
const ui = {
  section: 'plan', tab: 'lifting', range: 'all', activeId: null,
  inputs: {}, // {exerciseId: [{weight, reps}]} — today's unsaved sets
  saved: false, importing: false,
};

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------- stores

const programs = createStore({ key: 'tb.fitPrograms', file: 'programs.json', clean: F.cleanPrograms, render: () => render() });
const sessions = createStore({ key: 'tb.fitSessions', file: 'lifts.json', clean: F.cleanSessions, render: () => render() });
const weighins = createStore({ key: 'tb.fitWeighins', file: 'bodyweight.json', clean: F.cleanWeighins, render: () => render() });

export const stores = () => [programs.st, sessions.st, weighins.st];
export const syncAll = () => Promise.all([programs.sync(), sessions.sync(), weighins.sync()]);

const sortedPrograms = () => F.sortPrograms(programs.items);
const activeProgram = () => {
  const list = sortedPrograms();
  return list.find((p) => p.id === ui.activeId) || list[0] || null;
};
const exerciseNames = () => {
  const names = {};
  for (const p of programs.items) for (const e of p.exercises) names[e.id] = e.name;
  return names;
};

// ---------------------------------------------------------------- section switch

function setSection(section) {
  ui.section = section === 'fitness' ? 'fitness' : 'plan';
  const fit = ui.section === 'fitness';
  $('#plan').hidden = fit;
  $('#fitness').hidden = !fit;
  $('.datebar').hidden = fit;
  $('#fitRange').hidden = !fit;
  for (const b of document.querySelectorAll('#sectionToggle button')) {
    const on = b.dataset.section === ui.section;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  lsSet(SECTION_KEY, ui.section);
  if (fit) render();
}

export const isFitness = () => ui.section === 'fitness';

function setTab(tab) {
  ui.tab = tab;
  $('#fitness').dataset.tab = tab;
  for (const b of document.querySelectorAll('#fitTabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  render(); // charts in a panel that was hidden have to be drawn now that it has a width
}

function applyHash() {
  const s = new URLSearchParams(location.hash.slice(1)).get('app');
  if (s) setSection(s);
}

// ---------------------------------------------------------------- charts

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Resolve a token like var(--info) to a colour the canvas understands. */
function tokenColor(name) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

function sizeCanvas(canvas, w, hgt) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hgt}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const AXIS_W = 40;

/**
 * A path through `pts`. With `wobble` > 0 it's drawn freehand: each stretch is split into short steps
 * nudged sideways by a smooth, seeded noise, so it looks drawn with a pen yet never shifts between redraws.
 */
function tracePath(ctx, pts, wobble, seed = 0) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  let k = seed;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const n = wobble ? Math.max(1, Math.ceil(len / 6)) : 1;
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      k++;
      const off = j === n ? 0 : wobble * (0.6 * Math.sin(k * 1.7) + 0.4 * Math.sin(k * 0.53 + 1.3));
      ctx.lineTo(a.x + (b.x - a.x) * t - ((b.y - a.y) / len) * off, a.y + (b.y - a.y) * t + ((b.x - a.x) / len) * off);
    }
  }
}

// How a chart is drawn comes from the skin: the --chart-* tokens in styles.css and themes/*.css.
function chartStyle() {
  return {
    font: css('--chart-font') || '10px monospace',
    grid: tokenColor('--chart-grid'),
    label: tokenColor('--chart-label'),
    trend: tokenColor('--chart-trend'),
    mark: css('--chart-mark') === 'none' ? null : tokenColor('--chart-mark'),
    fill: parseFloat(css('--chart-fill')) || 0,
    point: css('--chart-point') || 'square',
    wobble: parseFloat(css('--chart-wobble')) || 0,
    paper: tokenColor('--surface-solid'),
  };
}

function drawChart(plot, axis, { values, labels, color, height, trend }) {
  const st = chartStyle();
  const pad = { top: 10, right: 10, bottom: 22, left: 8 };
  const W = plot.parentElement.getBoundingClientRect().width;
  const H = height;
  const ctx = sizeCanvas(plot, W, H);
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;
  const span = Math.max(...values) - Math.min(...values);
  const minV = Math.min(...values) - span * 0.15 - 0.5;
  const maxV = Math.max(...values) + span * 0.15 + 0.5;
  const range = maxV - minV || 1;
  const yFor = (v) => pad.top + cH - ((v - minV) / range) * cH;
  const pts = values.map((v, i) => ({ x: pad.left + (i / (values.length - 1 || 1)) * cW, y: yFor(v) }));
  const stroke = tokenColor(color);
  const freehand = st.wobble > 0;

  ctx.strokeStyle = st.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = Math.round(pad.top + (i / 3) * cH) + 0.5;
    tracePath(ctx, [{ x: 0, y }, { x: W, y }], st.wobble * 0.4, i * 31);
    ctx.stroke();
  }
  ctx.fillStyle = st.label;
  ctx.font = st.font;
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.ceil(values.length / Math.max(1, Math.floor(cW / 44))));
  let lastRight = -Infinity; // clamping to the canvas edge can push a label into its neighbour
  for (let i = 0; i < values.length; i += step) {
    const half = ctx.measureText(labels[i]).width / 2;
    const x = Math.min(Math.max(pts[i].x, half + 1), W - half - 1);
    if (x - half < lastRight + 8) continue;
    ctx.fillText(labels[i], x, H - 5);
    lastRight = x + half;
  }
  // Under the line: a tinted area, or a broad highlighter stroke along it.
  if (st.fill) {
    ctx.globalAlpha = st.fill;
    ctx.fillStyle = stroke;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, H - pad.bottom);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[pts.length - 1].x, H - pad.bottom);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (st.mark) {
    ctx.strokeStyle = st.mark;
    ctx.lineWidth = 7;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    tracePath(ctx, pts.map((p) => ({ x: p.x, y: p.y + 3 })), st.wobble * 1.5, 7);
    ctx.stroke();
  }
  if (trend) {
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = st.trend;
    ctx.lineWidth = 1.5;
    ctx.lineCap = freehand ? 'round' : 'butt';
    ctx.setLineDash([5, 3]);
    tracePath(ctx, trend.map((v, i) => ({ x: pts[i].x, y: yFor(v) })), st.wobble * 0.7, 3);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = freehand ? 'round' : 'miter';
  ctx.lineCap = freehand ? 'round' : 'butt';
  tracePath(ctx, pts, st.wobble);
  ctx.stroke();
  // Points when there's room: solid squares, or little circles drawn round each reading.
  if (cW / Math.max(1, values.length - 1) >= 10) {
    pts.forEach((p, i) => {
      if (st.point === 'ring') {
        const r = 3.2 + (freehand ? 0.6 * Math.sin(i * 2.3) : 0);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r + 0.4, r, i * 0.7, 0, Math.PI * 2);
        ctx.fillStyle = st.paper;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = stroke;
        ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
      }
    });
  }
  // Pinned Y axis, same scale as the plot.
  const ax = sizeCanvas(axis, AXIS_W, H);
  ax.fillStyle = st.label;
  ax.font = st.font;
  ax.textAlign = 'right';
  for (let i = 0; i < 4; i++) {
    const y = pad.top + (i / 3) * cH;
    const v = maxV - (i / 3) * range;
    ax.fillText(v < 10 ? v.toFixed(1) : String(Math.round(v)), AXIS_W - 6, y + 4);
  }
}

/** A line chart that redraws whenever its width changes (layout settling, a hidden tab shown, resizes). */
function chart(opts) {
  const { h } = deps;
  const plot = h('canvas', { class: 'fit-plot' });
  // Sized up front: an undrawn canvas is 300px wide and would squeeze the plot to nothing on a phone.
  const axis = h('canvas', { class: 'fit-axis', width: AXIS_W, style: { width: `${AXIS_W}px` } });
  const area = h('div', { class: 'fit-plot-area' }, plot);
  let lastW = 0;
  new ResizeObserver(() => {
    const w = Math.round(area.getBoundingClientRect().width);
    if (w > 0 && w !== lastW) {
      lastW = w;
      drawChart(plot, axis, opts);
    }
  }).observe(area);
  return h('div', { class: 'fit-chart', style: { height: `${opts.height}px` } }, axis, area);
}

const fmtShort = (date) => new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// ---------------------------------------------------------------- lifting log

function blankSets() {
  return Array.from({ length: BLANK_SETS }, () => ({ weight: '', reps: '' }));
}

function inputsFor(exId) {
  if (!ui.inputs[exId]) ui.inputs[exId] = blankSets();
  return ui.inputs[exId];
}

function saveDraft() {
  lsSet(DRAFT_KEY, JSON.stringify({ date: deps.todayStr(), inputs: ui.inputs }));
}

function loadDraft() {
  try {
    const d = JSON.parse(lsGet(DRAFT_KEY) || 'null');
    if (d?.date === deps.todayStr() && d.inputs && typeof d.inputs === 'object') ui.inputs = d.inputs;
  } catch { /* ignore */ }
}

function renderPrograms() {
  const { h } = deps;
  const active = activeProgram();
  $('#fitPrograms').replaceChildren(
    ...sortedPrograms().map((p) => h('button', {
      type: 'button', class: `chip-btn${p.id === active?.id ? ' active' : ''}`, 'aria-pressed': String(p.id === active?.id),
      onclick: () => { ui.activeId = p.id; ui.saved = false; render(); },
    }, p.name || 'Untitled')),
    h('button', { type: 'button', class: 'chip-btn fit-edit', onclick: openEditor }, 'Edit'),
  );
  $('#fitDay').textContent = active ? active.name : '';
}

function setRow(exId, set, i) {
  const { h } = deps;
  const sets = inputsFor(exId);
  const field = (key, placeholder, mode) => h('input', {
    type: 'text', inputmode: mode, class: `fit-in${key === 'weight' ? ' has-unit' : ''}`, value: set[key], placeholder,
    autocomplete: 'off', 'data-k': `${exId}:${i}:${key}`, 'aria-label': `Set ${i + 1} ${key}`,
    oninput: (e) => { sets[i][key] = e.target.value.replace(',', '.'); ui.saved = false; saveDraft(); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); focusNext(e.target); } },
  });
  return h('div', { class: 'fit-set' },
    h('span', { class: 'fit-num' }, String(i + 1)),
    h('label', { class: 'fit-unit' }, field('weight', 'kg', 'decimal'), h('span', {}, 'kg')),
    field('reps', 'reps', 'numeric'),
    h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `Remove set ${i + 1}`, title: 'Remove set',
      onclick: () => { sets.splice(i, 1); saveDraft(); renderLog(); },
    }, '×'),
  );
}

/** Enter moves weight → reps → next set's weight, like Tab, but stays inside the log. */
function focusNext(el) {
  const all = [...document.querySelectorAll('#fitLog .fit-in')];
  all[all.indexOf(el) + 1]?.focus();
}

function exerciseCard(ex) {
  const { h } = deps;
  const sets = inputsFor(ex.id);
  const hist = F.exerciseSessions(sessions.items, ex.id);
  const last = hist[hist.length - 1];
  return h('div', { class: 'fit-card' },
    h('div', { class: 'fit-card-head' },
      h('h3', {}, ex.name || 'Untitled'),
      last ? h('span', { class: 'fit-last', title: `Last session, ${fmtShort(last.date)}` }, `${fmtShort(last.date)} · ${F.setsToText(last.sets)}`) : null,
    ),
    h('div', { class: 'fit-set fit-set-head', 'aria-hidden': 'true' }, h('span', {}, '#'), h('span', {}, 'Weight'), h('span', {}, 'Reps'), h('span', {})),
    sets.map((s, i) => setRow(ex.id, s, i)),
    h('button', {
      type: 'button', class: 'linkish fit-add',
      onclick: () => {
        const l = sets[sets.length - 1] || { weight: '', reps: '' };
        sets.push({ weight: l.weight, reps: l.reps });
        saveDraft();
        renderLog();
        const ins = document.querySelectorAll(`#fitLog [data-k^="${CSS.escape(ex.id)}:"]`);
        ins[ins.length - 2]?.focus();
      },
    }, '+ Add set'),
  );
}

function renderLog() {
  const { h } = deps;
  const prog = activeProgram();
  // Re-rendering (e.g. after a sync) must not throw away the field being typed in.
  const focused = document.activeElement?.closest?.('#fitLog') ? document.activeElement.dataset.k : null;
  const el = $('#fitLog');
  if (!prog) {
    el.replaceChildren(h('p', { class: 'muted small empty' }, 'No split days yet. Open “Splits & data” and edit your splits.'));
    return;
  }
  if (!prog.exercises.length) {
    el.replaceChildren(h('p', { class: 'muted small empty' }, 'This day has no exercises. Click Edit to add some.'));
    return;
  }
  el.replaceChildren(
    ...prog.exercises.map(exerciseCard),
    h('button', { type: 'button', class: `btn primary fit-save${ui.saved ? ' saved' : ''}`, onclick: saveSession }, ui.saved ? '✓ Saved' : 'Save session'),
  );
  if (focused) el.querySelector(`[data-k="${CSS.escape(focused)}"]`)?.focus();
}

function saveSession() {
  const prog = activeProgram();
  if (!prog) return;
  const inputs = Object.fromEntries(prog.exercises.map((e) => [e.id, inputsFor(e.id)]));
  const records = F.sessionsFromInputs(inputs, deps.todayStr());
  if (!records.length) {
    flashNote('Fill in weight and reps for at least one set.');
    return;
  }
  sessions.items = F.upsert(sessions.items, records);
  sessions.persist();
  for (const e of prog.exercises) ui.inputs[e.id] = blankSets();
  saveDraft();
  ui.saved = true;
  render();
  setTimeout(() => { ui.saved = false; renderLog(); }, 2000);
}

// ---------------------------------------------------------------- progress and weight

function renderRange() {
  const { h } = deps;
  $('#fitRange').replaceChildren(...F.RANGES.map((r) => h('button', {
    type: 'button', class: ui.range === r.key ? 'active' : '', 'aria-pressed': String(ui.range === r.key),
    onclick: () => { ui.range = r.key; lsSet(RANGE_KEY, r.key); render(); },
  }, r.label)));
}

function renderProgress() {
  const { h } = deps;
  const prog = activeProgram();
  const today = deps.todayStr();
  const exs = prog?.exercises || [];
  const any = exs.some((e) => sessions.items.some((s) => s.ex === e.id));
  const cards = exs.map((ex) => {
    const hist = F.inRange(F.exerciseSessions(sessions.items, ex.id), ui.range, today);
    if (!hist.length) return null;
    const best = Math.max(...hist.map((s) => F.maxWeight(s.sets)));
    return h('div', { class: 'fit-card' },
      h('div', { class: 'fit-card-head' }, h('h3', {}, ex.name), h('span', { class: 'fit-last' }, `best ${best} kg · ${deps.plural(hist.length, 'session')}`)),
      chart({ values: hist.map((s) => F.maxWeight(s.sets)), labels: hist.map((s) => fmtShort(s.date)), color: '--chart-lift', height: 120 }),
    );
  }).filter(Boolean);
  $('#fitProgress').replaceChildren(...(cards.length ? cards : [h('p', { class: 'muted small empty' },
    any ? 'No sessions in this range.' : 'Save a session to start the progression charts.')]));
}

function logWeight(value) {
  const w = parseFloat(String(value).replace(',', '.'));
  if (!(w > 0)) return;
  const date = deps.todayStr();
  weighins.items = F.upsert(weighins.items, [{ id: date, date, weight: w }]);
  weighins.persist();
  render();
}

function renderWeight() {
  const { h } = deps;
  const sorted = [...weighins.items].sort(F.byDate);
  const latest = sorted[sorted.length - 1];
  $('#fitLatest').textContent = latest ? `${latest.weight} kg` : '';
  const data = F.inRange(sorted, ui.range, deps.todayStr());
  const trend = F.emaTrend(data);
  const input = h('input', {
    type: 'text', inputmode: 'decimal', class: 'fit-in', placeholder: latest ? `${latest.weight}` : 'kg', 'aria-label': 'Body weight in kg', autocomplete: 'off',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); logWeight(input.value); } },
  });
  $('#fitWeight').replaceChildren(
    data.length
      ? h('div', { class: 'fit-card' },
        h('div', { class: 'fit-card-head' }, h('h3', {}, 'Trend'), h('span', { class: 'fit-last' }, trend ? 'kg · dashed = 7-day trend' : 'kg')),
        chart({ values: data.map((d) => d.weight), labels: data.map((d) => fmtShort(d.date)), color: '--chart-weight', height: 170, trend }))
      : h('p', { class: 'muted small empty' }, sorted.length ? 'No weigh-ins in this range.' : 'Log your weight to start the chart.'),
    h('div', { class: 'fit-card' },
      h('div', { class: 'fit-card-head' }, h('h3', {}, 'Log weight'), h('span', { class: 'fit-last' }, 'today')),
      h('div', { class: 'fit-log-row' },
        h('label', { class: 'fit-unit' }, input, h('span', {}, 'kg')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => logWeight(input.value) }, 'Log'),
      ),
      sorted.length ? h('div', { class: 'fit-chips' }, sorted.slice(-10).reverse().map((e) => h('span', { class: 'tag fit-chip' },
        `${fmtShort(e.date)}: ${e.weight}`,
        h('button', {
          type: 'button', class: 'fit-chip-x', 'aria-label': `Remove weigh-in of ${fmtShort(e.date)}`,
          onclick: () => { weighins.items = weighins.items.filter((x) => x.id !== e.id); weighins.persist(); render(); },
        }, '×'),
      ))) : null,
    ),
  );
}

function renderSummary() {
  $('#fitDataSummary').textContent = `${deps.plural(sessions.items.length, 'session')} · ${deps.plural(weighins.items.length, 'weigh-in')}`;
}

let noteTimer;
function flashNote(text, { sticky = false } = {}) {
  const el = $('#fitImportNote');
  clearTimeout(noteTimer);
  el.textContent = text;
  $('#fitData').open = true;
  if (!sticky) noteTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}

// ---------------------------------------------------------------- dialogs (split editor, raw data)

function openModal(label, build) {
  const modal = $('#fitModal');
  const box = modal.querySelector('.fit-modal-box');
  box.setAttribute('aria-label', label);
  const rebuild = () => box.replaceChildren(...[].concat(build(rebuild)));
  rebuild();
  modal.hidden = false;
  box.querySelector('input, select, button')?.focus();
}

function closeModal() {
  $('#fitModal').hidden = true;
}

function modalHead(title) {
  const { h } = deps;
  return h('div', { class: 'fit-modal-head' },
    h('h2', { class: 'panel-title' }, title),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: closeModal }, '×'));
}

function modalFoot(onSave) {
  const { h } = deps;
  return h('div', { class: 'fit-modal-foot' },
    h('button', { type: 'button', class: 'btn ghost', onclick: closeModal }, 'Cancel'),
    h('button', { type: 'button', class: 'btn primary', onclick: onSave }, 'Save'));
}

function openEditor() {
  const { h } = deps;
  const ed = sortedPrograms().map((p) => ({ ...p, exercises: p.exercises.map((e) => ({ ...e })) }));
  let focusAfter = null; // [dayIndex, exerciseIndex] to focus once rebuilt
  openModal('Edit splits', (rebuild) => {
    const addExercise = (d) => {
      ed[d].exercises.push({ id: newId('ex'), name: '' });
      focusAfter = [d, ed[d].exercises.length - 1];
      rebuild();
    };
    const out = [
      modalHead('Edit splits'),
      h('div', { class: 'fit-modal-body' },
        ed.map((p, d) => h('div', { class: 'fit-card fit-day' },
          h('div', { class: 'fit-day-head' },
            h('input', { type: 'text', class: 'fit-day-name', value: p.name, placeholder: 'Day name (e.g. Tuesday)', 'aria-label': 'Day name', oninput: (e) => { p.name = e.target.value; } }),
            h('button', {
              type: 'button', class: 'icon-btn', title: 'Remove day', 'aria-label': 'Remove day', disabled: ed.length <= 1,
              onclick: () => { ed.splice(d, 1); rebuild(); },
            }, '×')),
          p.exercises.map((ex, i) => h('div', { class: 'fit-ex-row' },
            h('span', { class: 'fit-num' }, String(i + 1)),
            h('input', {
              type: 'text', value: ex.name, placeholder: 'Exercise name', 'aria-label': 'Exercise name', 'data-pos': `${d}:${i}`,
              oninput: (e) => { ex.name = e.target.value; },
              onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addExercise(d); } },
            }),
            h('button', { type: 'button', class: 'icon-btn', title: 'Remove exercise', 'aria-label': 'Remove exercise', onclick: () => { p.exercises.splice(i, 1); rebuild(); } }, '×'))),
          h('button', { type: 'button', class: 'linkish fit-add', onclick: () => addExercise(d) }, '+ Add exercise'))),
        h('button', {
          type: 'button', class: 'btn ghost fit-add-day',
          onclick: () => { ed.push({ id: newId('prog'), name: '', order: ed.length, exercises: [] }); addExercise(ed.length - 1); },
        }, '+ Add day'),
        h('p', { class: 'muted small' }, 'A day named after a weekday (e.g. “Tuesday”) opens by itself on that day. Press Enter in an exercise to add the next one.'),
      ),
      modalFoot(() => {
        // Blank rows left over from "+ Add" are dropped rather than saved as nameless entries.
        const next = ed.map((p) => ({ ...p, name: p.name.trim(), exercises: p.exercises.map((e) => ({ ...e, name: e.name.trim() })).filter((e) => e.name) }))
          .filter((p) => p.name).map((p, i) => ({ ...p, order: i }));
        if (!next.length) return;
        programs.items = next;
        programs.persist();
        closeModal();
        render();
      }),
    ];
    if (focusAfter) {
      const [d, i] = focusAfter;
      focusAfter = null;
      requestAnimationFrame(() => document.querySelector(`#fitModal [data-pos="${d}:${i}"]`)?.focus());
    }
    return out;
  });
}

function openRawData() {
  const { h } = deps;
  const names = exerciseNames();
  const rows = { weight: [...weighins.items].sort(F.byDate).map((w) => ({ ...w })), ex: {} };
  for (const s of [...sessions.items].sort(F.byDate)) (rows.ex[s.ex] ||= []).push({ ...s, text: F.setsToText(s.sets) });
  for (const id of Object.keys(names)) rows.ex[id] ||= [];
  const exIds = Object.keys(rows.ex).sort((a, b) => (names[a] || a).localeCompare(names[b] || b));
  let tab = 'weight';
  let exId = exIds[0] || null;
  const del = (list, i, rebuild) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove row', onclick: () => { list.splice(i, 1); rebuild(); } }, '×');
  const dateCell = (r) => h('input', { type: 'date', value: r.date, 'aria-label': 'Date', oninput: (e) => { r.date = e.target.value; } });

  openModal('Raw data', (rebuild) => {
    const body = tab === 'weight'
      ? [
        h('div', { class: 'fit-raw fit-raw-head', 'aria-hidden': 'true' }, h('span', {}, 'Date'), h('span', {}, 'Weight (kg)'), h('span', {})),
        rows.weight.map((r, i) => h('div', { class: 'fit-raw' },
          dateCell(r),
          h('input', { type: 'text', inputmode: 'decimal', class: 'mono', value: String(r.weight), 'aria-label': 'Weight', oninput: (e) => { r.weight = parseFloat(e.target.value.replace(',', '.')) || 0; } }),
          del(rows.weight, i, rebuild))),
        h('button', { type: 'button', class: 'linkish fit-add', onclick: () => { rows.weight.push({ date: deps.todayStr(), weight: 0 }); rebuild(); } }, '+ Add row'),
      ]
      : !exId ? [h('p', { class: 'muted small empty' }, 'No exercises yet.')]
        : [
          h('select', {
            class: 'fit-raw-select', 'aria-label': 'Exercise',
            onchange: (e) => { exId = e.target.value; rebuild(); },
          }, exIds.map((id) => h('option', { value: id, selected: id === exId }, names[id] || `${id} (not in a split)`))),
          h('div', { class: 'fit-raw fit-raw-head', 'aria-hidden': 'true' }, h('span', {}, 'Date'), h('span', {}, 'Sets (e.g. 75×5 / 80×3)'), h('span', {})),
          rows.ex[exId].map((r, i) => h('div', { class: 'fit-raw' },
            dateCell(r),
            h('input', { type: 'text', class: 'mono', value: r.text, placeholder: '75×5 / 80×3', 'aria-label': 'Sets', oninput: (e) => { r.text = e.target.value; } }),
            del(rows.ex[exId], i, rebuild))),
          h('button', { type: 'button', class: 'linkish fit-add', onclick: () => { rows.ex[exId].push({ date: deps.todayStr(), text: '' }); rebuild(); } }, '+ Add row'),
        ];
    return [
      modalHead('Raw data'),
      h('div', { class: 'view-toggle fit-raw-tabs', role: 'group', 'aria-label': 'Data' },
        [['weight', 'Body weight'], ['ex', 'Exercises']].map(([k, label]) => h('button', {
          type: 'button', class: tab === k ? 'active' : '', onclick: () => { tab = k; rebuild(); },
        }, label))),
      h('div', { class: 'fit-modal-body' }, body),
      modalFoot(() => {
        // Later rows win when two share a date; unchanged rows keep their stamps so sync sees no edit.
        const w = new Map();
        for (const r of rows.weight) if (/^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.weight > 0) w.set(r.date, { ...r, id: r.date });
        weighins.items = [...w.values()].map(({ text, ...r }) => r);
        const s = new Map();
        for (const [ex, list] of Object.entries(rows.ex)) {
          for (const r of list) {
            const sets = F.textToSets(r.text);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !sets.length) continue;
            const { text, ...rest } = r;
            const id = F.sessionId(ex, r.date);
            s.set(id, { ...rest, id, ex, date: r.date, sets: F.setsToText(sets) === F.setsToText(r.sets) ? r.sets : sets });
          }
        }
        sessions.items = [...s.values()];
        weighins.persist();
        sessions.persist();
        closeModal();
        render();
      }),
    ];
  });
}

// ---------------------------------------------------------------- Iron Log import

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error(`Couldn't load ${src}`));
    document.head.append(s);
  });
}

/** Iron Log's data in Firebase, after a Google sign-in to its Firebase project. */
async function readIronLogFirebase() {
  if (!window.firebase?.database) {
    await loadScript(`${FIREBASE_SDK}/firebase-app-compat.js`);
    await Promise.all([loadScript(`${FIREBASE_SDK}/firebase-auth-compat.js`), loadScript(`${FIREBASE_SDK}/firebase-database-compat.js`)]);
  }
  const fb = window.firebase;
  const app = fb.apps.find((a) => a.name === 'ironlog') || fb.initializeApp(IRON_LOG_FIREBASE, 'ironlog');
  const auth = app.auth();
  if (!auth.currentUser) await auth.signInWithPopup(new fb.auth.GoogleAuthProvider());
  const snap = await app.database().ref(`users/${auth.currentUser.uid}`).once('value');
  const data = snap.val();
  await auth.signOut().catch(() => {});
  return data;
}

/**
 * Iron Log's copy in this browser's IndexedDB (same origin when both apps are on github.io).
 * Never creates the database: that would leave Iron Log with an empty one it can't upgrade.
 */
async function readIronLogLocal() {
  if (!indexedDB.databases) return null;
  const dbs = await indexedDB.databases().catch(() => []);
  if (!dbs.some((d) => d.name === 'ironlog')) return null;
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('ironlog');
    r.onupgradeneeded = () => r.transaction.abort();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch(() => null);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains('data')) return null;
    const get = (k) => new Promise((res) => {
      const q = db.transaction('data').objectStore('data').get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(undefined);
    });
    return { programs: await get('programs'), history: await get('history'), bodyweight: await get('bodyweight') };
  } finally {
    db.close();
  }
}

async function importIronLog() {
  if (ui.importing) return;
  ui.importing = true;
  $('#fitImport').disabled = true;
  flashNote('Reading Iron Log… a Google sign-in window may open.', { sticky: true });
  try {
    const local = await readIronLogLocal().catch(() => null);
    let remote = null;
    let remoteError = '';
    try {
      remote = await readIronLogFirebase();
    } catch (e) {
      remoteError = e.code === 'auth/popup-closed-by-user' ? 'sign-in was cancelled' : e.message;
    }
    if (!local && !remote) {
      flashNote(`Nothing imported: ${remoteError || 'no Iron Log data found for this account'}.`, { sticky: true });
      return;
    }
    const empty = { programs: [], sessions: [], weighins: [] };
    const src = F.combineIronLog(local ? F.fromIronLog(local) : empty, remote ? F.fromIronLog(remote) : empty); // Firebase wins, like Iron Log's own sync
    const now = Date.now();
    // Splits nobody has edited here yet are replaced outright; edited ones only gain the missing days.
    const untouched = programs.items.every((p) => !(p.updatedAt || p.createdAt));
    // Days added to edited splits go after the existing ones.
    const after = Math.max(-1, ...programs.items.map((p) => p.order)) + 1;
    const prog = untouched && src.programs.length ? { items: src.programs, added: src.programs.length }
      : F.mergeImport(programs.items, src.programs.map((p) => ({ ...p, order: after + p.order })), now);
    const ses = F.mergeImport(sessions.items, src.sessions, now);
    const wts = F.mergeImport(weighins.items, src.weighins, now);
    programs.items = prog.items;
    sessions.items = ses.items;
    weighins.items = wts.items;
    programs.persist();
    sessions.persist();
    weighins.persist();
    lsSet(IMPORTED_KEY, String(now));
    if (!sortedPrograms().some((p) => p.id === ui.activeId)) pickToday();
    render();
    const from = [remote && 'Firebase', local && 'this browser'].filter(Boolean).join(' and ');
    const { plural } = deps;
    flashNote(`Imported ${plural(ses.added, 'session')}, ${plural(wts.added, 'weigh-in')} and ${plural(prog.added, 'split day')} from ${from}.`
      + (remoteError ? ` Firebase was skipped (${remoteError}).` : '') + ' Running it again only adds what’s missing.', { sticky: true });
  } catch (e) {
    flashNote(`Import failed: ${e.message}`, { sticky: true });
  } finally {
    ui.importing = false;
    $('#fitImport').disabled = false;
  }
}

// ---------------------------------------------------------------- init

function pickToday() {
  const list = sortedPrograms();
  const i = F.todaysProgram(list, deps.todayStr());
  ui.activeId = (list[i] || list[0])?.id || null;
}

export function render() {
  renderSummary();
  if (ui.section !== 'fitness') return;
  renderRange();
  renderPrograms();
  renderLog();
  renderProgress();
  renderWeight();
}

export function init(d) {
  deps = d;
  programs.load();
  sessions.load();
  weighins.load();
  if (!programs.items.length && !Object.keys(programs.st.deleted).length) {
    programs.st.items = F.DEFAULT_PROGRAMS.map((p) => ({ ...p, exercises: p.exercises.map((e) => ({ ...e })) }));
    programs.st.saved = programs.st.items;
  }
  ui.range = F.RANGES.some((r) => r.key === lsGet(RANGE_KEY)) ? lsGet(RANGE_KEY) : 'all';
  loadDraft();
  pickToday();

  for (const b of document.querySelectorAll('#sectionToggle button')) {
    b.addEventListener('click', () => {
      setSection(b.dataset.section);
      history.replaceState(null, '', ui.section === 'fitness' ? '#app=fitness' : location.pathname + location.search);
    });
  }
  for (const b of document.querySelectorAll('#fitTabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('#fitEditSplits').addEventListener('click', openEditor);
  $('#fitRawData').addEventListener('click', openRawData);
  $('#fitImport').addEventListener('click', importIronLog);
  $('#fitModal').addEventListener('mousedown', (e) => { if (e.target.id === 'fitModal') closeModal(); });
  $('#fitModal').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeModal(); } });
  // Charts read the skin's colours, so redraw once a newly picked skin's stylesheet has loaded.
  $('#skin')?.addEventListener('load', () => render());
  // …and once its web fonts arrive, since text already drawn on a canvas doesn't update by itself.
  document.fonts?.addEventListener('loadingdone', () => render());
  window.addEventListener('hashchange', applyHash);

  setTab(ui.tab);
  setSection(lsGet(SECTION_KEY) || 'plan');
  applyHash();
  if (lsGet(IMPORTED_KEY)) $('#fitImportNote').textContent = `Imported from Iron Log on ${new Date(Number(lsGet(IMPORTED_KEY))).toLocaleDateString('en-GB')}.`;
}
