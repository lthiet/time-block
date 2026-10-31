// Pure helpers for the Budget section: statement parsing, categories, monthly totals and leak detection.
// Everything is a flat record list so it syncs through the same per-record store as habits:
//   transactions {id, account, date, merchant, key, raw, amount, category, oneOff, pending, ref}
//     amount is signed CHF (money out is negative); category is '' unless set by hand on this transaction
//   rules        {id: <merchant key>, category}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const stamps = (x) => ({ createdAt: Number(x.createdAt) || 0, updatedAt: Number(x.updatedAt) || 0 });
const cents = (n) => Math.round(n * 100) / 100;
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export const UNCATEGORISED = 'Uncategorised';
export const CARD_BILL = 'Credit card (not itemised)';

// What each category counts as. Anything not listed is spending.
const KINDS = { Salary: 'income', Shares: 'income', 'Other income': 'income', Savings: 'saving', Transfer: 'transfer' };
export const kindOf = (category) => KINDS[category] || 'spend';

export const CATEGORIES = [
  'Housing', 'Groceries', 'Eating out', 'Transport', 'Car', 'Travel', 'Insurance', 'Health', 'Phone & internet',
  'Subscriptions', 'Shopping', 'Leisure', 'Personal care', 'Taxes', 'Cash', CARD_BILL, UNCATEGORISED,
  'Savings', 'Transfer', 'Salary', 'Shares', 'Other income',
];

// First match wins, so the specific entries (Uber Eats, Taxis on Booking) come before the general ones (Uber).
const BUILTIN = [
  ['Salary', /^credit salary/i],
  ['Shares', /morgan stanley|share plan/i],
  [CARD_BILL, /cembra|cumulus.*(master)?card|migros.*(master)?card/i],
  ['Savings', /finpension|\bviac\b|frankly|interactive brokers|swissquote|saxo bank|degiro/i],
  ['Eating out', /uber\s*\*?\s*eats|just eat|burger king|popeyes|mcdonald|starbucks|restaurant|kebab|sushi|pizza/i],
  ['Travel', /air france|swiss int|easyjet|lufthansa|booking|airbnb|hotel|ucpa|divers/i],
  ['Transport', /\buber\b|\bubr\b|\btaxi|\bsbb\b|\bzvv\b/i],
  ['Car', /amag|parkhaus|parking|\bshell\b|\bbp\b|\bavia\b|\btcs\b/i],
  ['Groceries', /\bcoop\b|coop-|migros|denner|\baldi\b|\blidl\b|\bvolg\b/i],
  ['Insurance', /sanitas|\bcss\b|helsana|swica|dextra|\baxa\b|mobiliar|rechtsschutz|versicherung/i],
  ['Health', /apotheke|pharmac|amavita|sunstore|\barzt\b|dental/i],
  ['Phone & internet', /swisscom|\bsalt\b|sunrise|\bwingo\b/i],
  ['Subscriptions', /crunchyroll|netflix|spotify|anthropic|openai|\bsuno\b|google one|icloud|apple\.com|youtube|disney/i],
  ['Shopping', /digitec|galaxus|decathlon|globus|zalando|amazon|manor|ikea|aliexpress/i],
  ['Leisure', /steam|playtomic|\bkino\b|cinema/i],
  ['Personal care', /\bhair\b|coiffeur|barber/i],
  ['Taxes', /steueramt|steuerverwaltung/i],
  ['Housing', /immobilien|liegenschaft/i],
  ['Cash', /\batm\b|bancomat/i],
];

// ---------------------------------------------------------------- cleaning

export function cleanTransactions(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((t) => t && t.id && DATE_RE.test(t.date || '')).map((t) => ({
    id: String(t.id), account: String(t.account || ''), date: t.date,
    merchant: String(t.merchant || ''), key: String(t.key || ''), raw: String(t.raw || ''),
    amount: num(t.amount), category: String(t.category || ''), oneOff: !!t.oneOff, pending: !!t.pending,
    ref: String(t.ref || ''), ...stamps(t),
  }));
}

export function cleanRules(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && r.id && r.category).map((r) => ({ id: String(r.id), category: String(r.category), ...stamps(r) }));
}

// ---------------------------------------------------------------- parsing

/** Rows of a `;` separated CSV with double-quoted fields; a leading BOM is ignored. */
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const PREFIX = /^(?:(?:online )?purchase(?: with)? zkb visa debit card no\.? x+ ?\d+,?|debit twint:|debit mobile banking:|debit ebill:|debit standing order(?: \(\d+\))?|debit\b:?|credit originator:|credit salary:|credit\b:?)\s*/i;

/** A readable merchant name from a booking text: no booking prefix, card number, address or phone number. */
export function cleanMerchant(text) {
  const raw = String(text || '').trim();
  const name = raw.replace(PREFIX, '').replace(/\s*\+\d{6,}\s*$/, '').trim();
  const isCard = /visa debit card/i.test(raw);
  const isTwint = /^debit twint:/i.test(raw);
  // Bank payments read "Name, street, town": only the name matters. Card and TWINT text has no address.
  return (isCard || isTwint ? name : name.split(',')[0]).replace(/\s+/g, ' ').trim();
}

/** Groups spellings of one merchant: lower case, tight around "*", without trailing store and terminal numbers. */
export function merchantKey(merchant) {
  return String(merchant || '').toLowerCase().replace(/\s*\*\s*/g, '*').replace(/\s+/g, ' ').replace(/(?:\s+\d+)+$/, '').trim();
}

const isoDate = (d) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(d).trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

const ZKB_COLUMNS = ['Date', 'Booking text', 'Curr', 'Amount details', 'ZKB reference', 'Debit CHF', 'Credit CHF', 'Value date'];

function makeTx({ ref, date, text, amount, pending, id }) {
  const merchant = cleanMerchant(text);
  return { id, account: 'zkb', date, merchant, key: merchantKey(merchant), raw: text, amount: cents(amount), category: '', oneOff: false, pending, ref };
}

/**
 * Transactions from a ZKB account statement CSV (English export). A collective booking such as a standing order
 * is one row followed by dateless detail rows: the details are imported instead of it, so nothing counts twice.
 */
export function parseZkbCsv(text) {
  const [header, ...rows] = parseCsv(text);
  const col = Object.fromEntries((header || []).map((name, i) => [name.trim(), i]));
  const missing = ZKB_COLUMNS.filter((name) => !(name in col));
  if (missing.length) throw new Error('This doesn’t look like a ZKB statement in English: its columns are not the expected ones.');
  const get = (r, name) => (r[col[name]] ?? '').trim();

  const groups = [];
  for (const r of rows) {
    if (get(r, 'Date')) groups.push({ row: r, details: [] });
    else if (get(r, 'Booking text') && groups.length) groups[groups.length - 1].details.push(r);
  }

  const seen = {};
  const out = [];
  for (const { row, details } of groups) {
    const date = isoDate(get(row, 'Date'));
    if (!date) continue;
    const debit = num(get(row, 'Debit CHF'));
    const amount = debit ? -debit : num(get(row, 'Credit CHF'));
    const ref = get(row, 'ZKB reference');
    const pending = !ref && !get(row, 'Value date');
    const textOf = get(row, 'Booking text');
    const sign = amount < 0 ? -1 : 1;
    // Details in another currency can't be added up, so then the booking stays whole.
    const inChf = details.length && details.every((d) => get(d, 'Curr') === 'CHF');
    const sum = inChf ? details.reduce((a, d) => a + num(get(d, 'Amount details')), 0) : 0;
    if (inChf && Math.abs(sum - Math.abs(amount)) < 0.005) {
      details.forEach((d, i) => {
        out.push(makeTx({ id: `zkb:${ref || date}#${i + 1}`, ref, date, text: get(d, 'Booking text'), amount: sign * num(get(d, 'Amount details')), pending }));
      });
      continue;
    }
    let id = `zkb:${ref}`;
    if (!ref) {
      // No reference yet. Two identical purchases on one day stay apart through their position.
      const base = `zkb:p:${date}:${amount}:${merchantKey(cleanMerchant(textOf))}`;
      seen[base] = (seen[base] || 0) + 1;
      id = `${base}:${seen[base]}`;
    }
    out.push(makeTx({ id, ref, date, text: textOf, amount, pending }));
  }
  return out;
}

// One entry per supported statement. A new bank or card adds its parser here.
const SOURCES = [{ test: (text) => /"?ZKB reference"?/.test(text.slice(0, 500)), parse: parseZkbCsv }];

export function parseStatement(text) {
  const source = SOURCES.find((s) => s.test(text));
  if (!source) throw new Error('This file isn’t a supported statement. Budget reads ZKB account statements exported as CSV in English.');
  return source.parse(text);
}

// ---------------------------------------------------------------- import

/**
 * Add parsed transactions to the list. Known ones are kept untouched, with your edits. A pending row disappears
 * once a file that reaches its date no longer has it (it was booked under a new reference); a hand-set category
 * or one-off mark moves to the booked row with the same merchant and amount.
 */
export function applyImport(existing, parsed) {
  const ids = new Set(parsed.map((t) => t.id));
  const known = new Set(existing.map((t) => t.id));
  const reach = {};
  for (const t of parsed) if (!(reach[t.account] >= t.date)) reach[t.account] = t.date;
  const booked = {};
  for (const t of existing) if (!t.pending && !(booked[t.account] >= t.date)) booked[t.account] = t.date;

  const stale = existing.filter((t) => t.pending && !ids.has(t.id) && reach[t.account] >= t.date);
  const gone = new Set(stale.map((t) => t.id));
  const kept = existing.filter((t) => !gone.has(t.id));
  // An old file's pending rows have been booked since, and the booked rows are already here.
  const fresh = parsed.filter((t) => !known.has(t.id) && !(t.pending && booked[t.account] > reach[t.account]));
  const added = fresh.map((t) => {
    const was = stale.find((p) => p.key === t.key && p.amount === t.amount && (p.category || p.oneOff));
    return was ? { ...t, category: was.category, oneOff: was.oneOff } : t;
  });
  return { items: [...kept, ...added], added: added.length, skipped: parsed.length - added.length, removed: stale.length };
}

// ---------------------------------------------------------------- categories

/** A hand-set category beats your merchant rule, which beats the built-in merchant list. */
export function categorise(tx, rules = []) {
  if (tx.category) return tx.category;
  const rule = tx.key && rules.find((r) => r.id === tx.key);
  if (rule) return rule.category;
  for (const [category, re] of BUILTIN) if (re.test(tx.raw) || re.test(tx.merchant)) return category;
  return tx.amount > 0 ? 'Other income' : UNCATEGORISED;
}

// ---------------------------------------------------------------- totals

const monthOf = (date) => date.slice(0, 7);

const visible = (txs, oneOffs) => (oneOffs ? txs : txs.filter((t) => !t.oneOff));

/** Totals per month, oldest first. `net` is what's left of the income after spending and saving. */
export function monthSummary(txs, rules = [], { oneOffs = true } = {}) {
  const months = {};
  for (const t of visible(txs, oneOffs)) {
    const m = monthOf(t.date);
    const row = months[m] ||= { month: m, income: 0, spend: 0, saved: 0, transferred: 0 };
    const kind = kindOf(categorise(t, rules));
    if (kind === 'income') row.income += t.amount;
    else if (kind === 'spend') row.spend -= t.amount; // a refund (positive) lowers spending
    else if (kind === 'saving') row.saved -= t.amount;
    else row.transferred -= t.amount;
  }
  return Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({
    month: r.month, income: cents(r.income), spend: cents(r.spend), saved: cents(r.saved),
    transferred: cents(r.transferred), net: cents(r.income - r.spend - r.saved),
  }));
}

/** Spending per category, largest first; `month` null means all months. [{category, total, count}] */
export function categoryTotals(txs, rules = [], { month = null, oneOffs = true } = {}) {
  const totals = {};
  for (const t of visible(txs, oneOffs)) {
    if (month && monthOf(t.date) !== month) continue;
    const category = categorise(t, rules);
    if (kindOf(category) !== 'spend') continue;
    const row = totals[category] ||= { category, total: 0, count: 0 };
    row.total -= t.amount;
    row.count++;
  }
  return Object.values(totals).map((r) => ({ ...r, total: cents(r.total) })).sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------- leaks

export const LEAK_MIN_MONTHS = 3;
const CREEP_MONTHS = 3; // compared with the same number of months before them
const CREEP_RATIO = 1.2;
const CREEP_MIN_RISE = 30;
const SMALL_AMOUNT = 20;
const SMALL_PER_MONTH = 4;
const RECURRING_SPREAD = 0.25;
const NOT_A_LEAK = new Set(['Housing', CARD_BILL, UNCATEGORISED, 'Taxes', 'Cash']);

/** Months the statements cover from start to end: not the current month, and not one whose first days are missing. */
export function completeMonths(txs, today) {
  if (!txs.length) return [];
  const first = txs.map((t) => t.date).sort()[0];
  const months = [...new Set(txs.map((t) => monthOf(t.date)))].sort();
  return months.filter((m) => m < monthOf(today) && (m > monthOf(first) || first <= `${m}-05`));
}

const leak = (type, title, detail, perMonth) => ({ type, title, detail, perMonth: cents(perMonth), perYear: cents(perMonth * 12) });

/**
 * Where money slips away, biggest yearly amount first. Needs LEAK_MIN_MONTHS complete months;
 * until then `ready` is false and `have` says how many there are.
 */
export function leaks(txs, rules = [], today) {
  const months = completeMonths(txs, today);
  if (months.length < LEAK_MIN_MONTHS) return { ready: false, have: months.length, need: LEAK_MIN_MONTHS, items: [] };
  const inMonths = new Set(months);
  const spend = txs
    .filter((t) => inMonths.has(monthOf(t.date)) && !t.oneOff && t.amount < 0)
    .map((t) => ({ ...t, cat: categorise(t, rules), month: monthOf(t.date), out: -t.amount }))
    .filter((t) => kindOf(t.cat) === 'spend');

  const byMerchant = {};
  for (const t of spend) if (t.key && !NOT_A_LEAK.has(t.cat)) (byMerchant[t.key] ||= []).push(t);

  const items = [];
  const recurring = new Set();
  for (const [key, list] of Object.entries(byMerchant)) {
    const seen = new Set(list.map((t) => t.month));
    const amounts = list.map((t) => t.out).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const steady = (amounts[amounts.length - 1] - amounts[0]) <= median * RECURRING_SPREAD;
    const active = seen.has(months[months.length - 1]) || seen.has(months[months.length - 2]);
    if (seen.size >= LEAK_MIN_MONTHS && list.length <= seen.size * 1.5 && steady && active) {
      recurring.add(key);
      const total = amounts.reduce((a, b) => a + b, 0);
      items.push(leak('recurring', list[list.length - 1].merchant, `Charged in ${seen.size} of ${months.length} months. Do you still use it?`, total / months.length));
    }
  }

  for (const [key, list] of Object.entries(byMerchant)) {
    if (recurring.has(key)) continue;
    const small = list.filter((t) => t.out < SMALL_AMOUNT);
    if (small.length / months.length < SMALL_PER_MONTH) continue;
    const total = small.reduce((a, t) => a + t.out, 0);
    items.push(leak('small', small[small.length - 1].merchant, `${Math.round(small.length / months.length)} purchases a month under CHF ${SMALL_AMOUNT}.`, total / months.length));
  }

  if (months.length >= CREEP_MONTHS * 2) {
    const recent = new Set(months.slice(-CREEP_MONTHS));
    const before = new Set(months.slice(-CREEP_MONTHS * 2, -CREEP_MONTHS));
    const totals = {};
    for (const t of spend) {
      if (NOT_A_LEAK.has(t.cat)) continue;
      const row = totals[t.cat] ||= { recent: 0, before: 0 };
      if (recent.has(t.month)) row.recent += t.out / CREEP_MONTHS;
      else if (before.has(t.month)) row.before += t.out / CREEP_MONTHS;
    }
    for (const [cat, { recent: now, before: then }] of Object.entries(totals)) {
      if (then > 0 && now > then * CREEP_RATIO && now - then >= CREEP_MIN_RISE) {
        items.push(leak('creep', cat, `Up ${Math.round((now / then - 1) * 100)}% over the last ${CREEP_MONTHS} months: CHF ${Math.round(then)} to ${Math.round(now)} a month.`, now - then));
      }
    }
  }
  return { ready: true, have: months.length, need: LEAK_MIN_MONTHS, items: items.sort((a, b) => b.perYear - a.perYear) };
}
