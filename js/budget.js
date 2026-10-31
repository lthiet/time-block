// The Budget section: import bank statements, see where the money goes, and find leaks.
// Transactions and merchant rules sync through their own files in the app's Google Drive folder,
// with the same per-record store as habits.
import { createStore } from './journal.js?v=27'; // must match app.js's import, so all share one module
import * as B from './budget-logic.js?v=1';

const $ = (sel) => document.querySelector(sel);
const ONE_OFFS_KEY = 'tb.budOneOffs';

let deps; // {h, plural, todayStr}
const ui = {
  tab: 'overview', month: null, oneOffs: true, category: '', search: '',
  note: '', offer: null, // offer: {key, merchant, category} — "apply to all from this merchant"
};

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

// ---------------------------------------------------------------- stores

const txs = createStore({ key: 'tb.budTx', file: 'budget-tx.json', clean: B.cleanTransactions, render: () => render() });
const rules = createStore({ key: 'tb.budRules', file: 'budget-rules.json', clean: B.cleanRules, render: () => render() });

export const stores = () => [txs.st, rules.st];
export const syncAll = () => Promise.all([txs.sync(), rules.sync()]);

// ---------------------------------------------------------------- helpers

const money = (n, digits = 0) => n.toLocaleString('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const shortMonth = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short' });
const months = () => [...new Set(txs.items.map((t) => t.date.slice(0, 7)))].sort();

/** The chosen month, or the newest one if the chosen one is gone. null means all months. */
function activeMonth() {
  const list = months();
  if (ui.month === 'all') return null;
  return list.includes(ui.month) ? ui.month : list[list.length - 1] || null;
}

/** Days from the first to the last transaction, to be honest about how little a short statement says. */
function coverage() {
  const dates = txs.items.map((t) => t.date).sort();
  if (!dates.length) return null;
  const days = Math.round((new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86_400_000) + 1;
  return { from: dates[0], to: dates[dates.length - 1], days };
}

// ---------------------------------------------------------------- import

async function importFiles(files) {
  const { plural } = deps;
  const notes = [];
  for (const file of files) {
    try {
      const res = B.applyImport(txs.items, B.parseStatement(await file.text()));
      txs.items = res.items;
      notes.push(`${file.name}: added ${res.added}, skipped ${res.skipped} already here${res.removed ? `, replaced ${plural(res.removed, 'pending row')}` : ''}.`);
    } catch (e) {
      notes.push(`${file.name}: ${e.message}`);
    }
  }
  txs.persist();
  const open = txs.items.filter((t) => B.categorise(t, rules.items) === B.UNCATEGORISED).length;
  if (open) notes.push(`${plural(open, 'transaction')} still uncategorised.`);
  ui.note = notes.join(' ');
  ui.month = null;
  render();
}

// ---------------------------------------------------------------- edits

function setCategory(tx, category) {
  txs.items = txs.items.map((t) => (t.id === tx.id ? { ...t, category } : t));
  txs.persist();
  const others = tx.key ? txs.items.filter((t) => t.key === tx.key && t.id !== tx.id).length : 0;
  ui.offer = tx.key ? { key: tx.key, merchant: tx.merchant, category, others } : null;
  render();
}

function applyRule({ key, category }) {
  const rest = rules.items.filter((r) => r.id !== key);
  rules.items = [...rest, { id: key, category, createdAt: Date.now(), updatedAt: Date.now() }];
  rules.persist();
  // The rule now speaks for this merchant, so hand-set categories on its rows would only hide later changes.
  txs.items = txs.items.map((t) => (t.key === key && t.category ? { ...t, category: '' } : t));
  txs.persist();
  ui.offer = null;
  render();
}

function toggleOneOff(tx) {
  txs.items = txs.items.map((t) => (t.id === tx.id ? { ...t, oneOff: !t.oneOff } : t));
  txs.persist();
  render();
}

// ---------------------------------------------------------------- overview

function renderControls() {
  const { h } = deps;
  const list = months();
  const active = activeMonth();
  const select = h('select', {
    'aria-label': 'Month', disabled: !list.length || undefined,
    onchange: (e) => { ui.month = e.target.value; ui.category = ''; render(); },
  },
  h('option', { value: 'all', selected: ui.month === 'all' || undefined }, 'All months'),
  [...list].reverse().map((m) => h('option', { value: m, selected: m === active || undefined }, monthLabel(m))));
  const oneOffs = h('label', { class: 'inline' },
    h('input', { type: 'checkbox', checked: ui.oneOffs || undefined, onchange: (e) => { ui.oneOffs = e.target.checked; lsSet(ONE_OFFS_KEY, ui.oneOffs ? '1' : '0'); render(); } }),
    ' Include one-offs');
  $('#budControls').replaceChildren(select, oneOffs);
}

function stat(label, value, cls = '') {
  const { h } = deps;
  return h('div', { class: `bud-stat ${cls}` }, h('span', { class: 'bud-stat-label' }, label), h('span', { class: 'bud-stat-value' }, money(value)));
}

function renderOverview() {
  const { h } = deps;
  const el = $('#budOverview');
  if (!txs.items.length) {
    el.replaceChildren(h('p', { class: 'muted small empty' }, 'Export a statement from ZKB eBanking as CSV in English and import it here. A year of history gives the best picture; it stays in this browser and your private Drive app folder.'));
    return;
  }
  const opts = { oneOffs: ui.oneOffs };
  const active = activeMonth();
  const summary = B.monthSummary(txs.items, rules.items, opts);
  const totals = active
    ? summary.find((r) => r.month === active) || { income: 0, spend: 0, saved: 0, transferred: 0, net: 0 }
    : summary.reduce((a, r) => ({ income: a.income + r.income, spend: a.spend + r.spend, saved: a.saved + r.saved, transferred: a.transferred + r.transferred, net: a.net + r.net }), { income: 0, spend: 0, saved: 0, transferred: 0, net: 0 });
  const cats = B.categoryTotals(txs.items, rules.items, { month: active, ...opts });
  const top = Math.max(1, ...cats.map((c) => c.total));
  const peak = Math.max(1, ...summary.map((r) => r.spend));
  const cover = coverage();

  el.replaceChildren(
    cover.days < 60 ? h('p', { class: 'bud-warn small' }, `These statements only cover ${cover.days} days (${cover.from} to ${cover.to}), so this isn’t a typical picture yet.`) : '',
    h('div', { class: 'bud-stats' },
      stat('Income', totals.income),
      stat('Spent', totals.spend),
      stat('Saved', totals.saved),
      stat('Left', totals.net, totals.net < 0 ? 'neg' : '')),
    totals.transferred ? h('p', { class: 'muted small bud-aside' }, `CHF ${money(totals.transferred)} moved between your own accounts isn’t counted.`) : '',
    h('h3', { class: 'fit-group' }, 'Spending by category, CHF'),
    cats.length ? h('ol', { class: 'bud-bars' }, cats.map((c) => h('li', {},
      h('button', {
        type: 'button', class: `bud-bar${ui.category === c.category ? ' active' : ''}`,
        title: `${c.category}: CHF ${money(c.total, 2)}, ${deps.plural(c.count, 'transaction')}. Click to list them.`,
        onclick: () => { ui.category = ui.category === c.category ? '' : c.category; setTab('transactions'); },
      },
      h('span', { class: 'bud-bar-name' }, c.category),
      h('span', { class: 'bud-bar-track' }, h('i', { style: { width: `${Math.max(0, (c.total / top) * 100)}%` } })),
      h('span', { class: 'bud-bar-value' }, money(c.total)))))) : h('p', { class: 'muted small' }, 'No spending here.'),
    summary.length > 1 ? [
      h('h3', { class: 'fit-group' }, 'Spent per month, CHF'),
      h('div', { class: 'bud-trend', role: 'img', 'aria-label': summary.map((r) => `${monthLabel(r.month)}: CHF ${money(r.spend)}`).join(', ') },
        summary.map((r) => h('button', {
          type: 'button', class: `bud-col${r.month === active ? ' active' : ''}`,
          title: `${monthLabel(r.month)}: spent CHF ${money(r.spend)}, income CHF ${money(r.income)}, saved CHF ${money(r.saved)}`,
          onclick: () => { ui.month = r.month; ui.category = ''; render(); },
        },
        h('span', { class: 'bud-col-bar' }, h('i', { style: { height: `${Math.max(0, (r.spend / peak) * 100)}%` } })),
        h('span', { class: 'bud-col-label' }, shortMonth(r.month))))),
    ] : '',
  );
}

// ---------------------------------------------------------------- leaks

const LEAK_TYPE = { recurring: 'Recurring', small: 'Small and often', creep: 'Creeping up' };

function renderLeaks() {
  const { h, plural, todayStr } = deps;
  const el = $('#budLeaks');
  const res = B.leaks(txs.items, rules.items, todayStr());
  if (!res.ready) {
    el.replaceChildren(h('p', { class: 'muted small empty' },
      `Suggestions need ${res.need} complete months of statements, so they’re based on your habits and not on one odd week. You have ${res.have}. Export a longer period from ZKB and import it.`));
    return;
  }
  if (!res.items.length) {
    el.replaceChildren(h('p', { class: 'muted small empty' }, `Nothing stands out in ${plural(res.have, 'complete month')} of statements.`));
    return;
  }
  const yearly = res.items.reduce((a, i) => a + i.perYear, 0);
  el.replaceChildren(
    h('p', { class: 'muted small bud-aside' }, `From ${plural(res.have, 'complete month')} of statements. These add up to about CHF ${money(yearly)} a year, and some may overlap.`),
    res.items.map((i) => h('article', { class: 'fit-card bud-leak' },
      h('div', { class: 'fit-card-head' }, h('h3', {}, i.title), h('span', { class: 'bud-leak-cost' }, `CHF ${money(i.perMonth)}/mo · ${money(i.perYear)}/yr`)),
      h('div', { class: 'small' }, h('span', { class: 'badge' }, LEAK_TYPE[i.type]), ' ', i.detail))),
  );
}

// ---------------------------------------------------------------- transactions

function txRow(t) {
  const { h } = deps;
  const category = B.categorise(t, rules.items);
  return h('li', { class: `bud-tx${t.oneOff ? ' one-off' : ''}`, title: t.raw },
    h('span', { class: 'bud-tx-date' }, t.date.slice(5)),
    h('span', { class: 'bud-tx-name' }, t.merchant || '(no merchant name)', t.pending ? h('span', { class: 'muted small' }, ' pending') : ''),
    h('span', { class: `bud-tx-amount${t.amount > 0 ? ' in' : ''}` }, money(t.amount, 2)),
    h('select', { class: 'bud-tx-cat', 'aria-label': `Category of ${t.merchant || 'transaction'}`, onchange: (e) => setCategory(t, e.target.value) },
      B.CATEGORIES.map((c) => h('option', { value: c, selected: c === category || undefined }, c))),
    h('button', {
      type: 'button', class: `chip-btn bud-tx-one${t.oneOff ? ' active' : ''}`, 'aria-pressed': String(t.oneOff),
      title: t.oneOff ? 'Marked one-off. Click to count it as normal spending' : 'Mark as a one-off, like a holiday or a deposit', onclick: () => toggleOneOff(t),
    }, '1×'));
}

function renderTransactions() {
  const { h, plural } = deps;
  const active = activeMonth();
  const q = ui.search.trim().toLowerCase();
  const list = txs.items
    .filter((t) => (!active || t.date.startsWith(active))
      && (!ui.category || B.categorise(t, rules.items) === ui.category)
      && (!q || t.merchant.toLowerCase().includes(q) || t.raw.toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

  $('#budTxCount').textContent = String(list.length);
  const filter = $('#budTxCategory');
  filter.replaceChildren(
    h('option', { value: '' }, 'All categories'),
    B.CATEGORIES.map((c) => h('option', { value: c, selected: c === ui.category || undefined }, c)));

  const offer = ui.offer;
  $('#budOffer').replaceChildren(...(offer && offer.others ? [
    h('button', { type: 'button', class: 'linkish', onclick: () => applyRule(offer) }, `Set all ${offer.others + 1} from ${offer.merchant} to ${offer.category}`),
    ' ', h('button', { type: 'button', class: 'linkish', onclick: () => { ui.offer = null; render(); } }, 'Not now'),
  ] : offer ? [
    h('button', { type: 'button', class: 'linkish', onclick: () => applyRule(offer) }, `Always use ${offer.category} for ${offer.merchant}`),
  ] : []));

  $('#budTxList').replaceChildren(...(list.length ? list.map(txRow) : [h('li', { class: 'muted small empty' }, txs.items.length ? `No transactions match (${plural(txs.items.length, 'transaction')} in total).` : 'Nothing imported yet.')]));
}

// ---------------------------------------------------------------- init

function setTab(tab) {
  ui.tab = tab;
  $('#budget').dataset.tab = tab;
  for (const b of document.querySelectorAll('#budTabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  render();
}

export function render() {
  if (!deps || $('#budget').hidden) return;
  $('#budNote').textContent = ui.note;
  renderControls();
  renderOverview();
  renderLeaks();
  renderTransactions();
}

export function init(d) {
  deps = d;
  txs.load();
  rules.load();
  ui.oneOffs = lsGet(ONE_OFFS_KEY) !== '0';

  for (const b of document.querySelectorAll('#budTabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('#budFile').addEventListener('change', async (e) => {
    await importFiles([...e.target.files]);
    e.target.value = ''; // so the same file can be picked again
  });
  $('#budImport').addEventListener('click', () => $('#budFile').click());
  $('#budSearch').addEventListener('input', (e) => { ui.search = e.target.value; renderTransactions(); });
  $('#budTxCategory').addEventListener('change', (e) => { ui.category = e.target.value; render(); });
  const zone = $('#budget');
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]);
  });
  setTab(ui.tab);
}
