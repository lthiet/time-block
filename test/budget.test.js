import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, parseZkbCsv, parseStatement, cleanMerchant, merchantKey, applyImport, categorise, kindOf,
  monthSummary, categoryTotals, completeMonths, leaks, cleanTransactions, cleanRules, UNCATEGORISED,
} from '../js/budget-logic.js';

// Made-up rows in the shape of a ZKB export.
const HEAD = '﻿"Date";"Booking text";"Curr";"Amount details";"ZKB reference";"Reference number";"Debit CHF";"Credit CHF";"Value date";"Balance CHF";"Payment purpose";"Details"';
const row = (date, text, ref, debit, credit = '', curr = '', detail = '') =>
  `"${date}";"${text}";"${curr}";"${detail}";"${ref}";"";"${debit}";"${credit}";"${ref ? date : ''}";"";"";""`;
const csv = (...rows) => [HEAD, ...rows, ''].join('\r\n');

const CARD = 'Purchase ZKB Visa Debit card no. xxxx 1234,';

test('parseCsv handles the BOM, quotes, escaped quotes and CRLF', () => {
  assert.deepEqual(parseCsv('﻿"a";"b ""c"";d"\r\n"1";""\r\n'), [['a', 'b "c";d'], ['1', '']]);
});

test('a standing order becomes its details, never the booking as well', () => {
  const txs = parseZkbCsv(csv(
    row('23.10.2026', 'Debit Standing order (2)', 'Z1', '1500.00'),
    row('', 'Sample Immobilien AG, Street 1, 8000 Zürich, CH', '', '', '', 'CHF', '1000.00'),
    row('', 'finpension 3a, 6430 Schwyz, CH', '', '', '', 'CHF', '500.00'),
  ));
  assert.deepEqual(txs.map((t) => [t.id, t.date, t.merchant, t.amount]), [
    ['zkb:Z1#1', '2026-10-23', 'Sample Immobilien AG', -1000],
    ['zkb:Z1#2', '2026-10-23', 'finpension 3a', -500],
  ]);
});

test('details that do not add up leave the booking whole', () => {
  const txs = parseZkbCsv(csv(
    row('23.10.2026', 'Debit Standing order (1)', 'Z1', '90.00'),
    row('', 'Overseas Ltd', '', '', '', 'USD', '100.00'),
  ));
  assert.deepEqual(txs.map((t) => [t.id, t.amount]), [['zkb:Z1', -90]]);
});

test('rows without a reference are pending, and identical ones stay apart', () => {
  const txs = parseZkbCsv(csv(row('30.10.2026', `${CARD} SHOP`, '', '5.00'), row('30.10.2026', `${CARD} SHOP`, '', '5.00')));
  assert.equal(txs.length, 2);
  assert.notEqual(txs[0].id, txs[1].id);
  assert.ok(txs.every((t) => t.pending));
});

test('credits are positive and a foreign file is refused', () => {
  const [t] = parseZkbCsv(csv(row('23.10.2026', 'Credit salary: ACME GMBH, ZURICH', 'Z2', '', '5000.00')));
  assert.equal(t.amount, 5000);
  assert.equal(t.merchant, 'ACME GMBH');
  assert.throws(() => parseStatement('a;b;c\n1;2;3'), /supported/);
  assert.throws(() => parseZkbCsv('"ZKB reference";"x"\n'), /ZKB statement/);
});

test('merchant names lose prefixes, addresses and numbers', () => {
  assert.equal(cleanMerchant('Online purchase with ZKB Visa Debit card No. xxxx 1234, STORE AG'), 'STORE AG');
  assert.equal(cleanMerchant('Online purchase with ZKB Visa Debit card No. xxxx 1234'), '');
  assert.equal(cleanMerchant('Debit eBill: Telco AG, Road 6, 3050 Bern'), 'Telco AG');
  assert.equal(cleanMerchant('Debit TWINT: DOE, JANE +41790000000'), 'DOE, JANE');
  assert.equal(merchantKey('UBER   * EATS 00000'), merchantKey('UBER *EATS'));
  assert.equal(merchantKey('Coop Pronto 4638 0813'), 'coop pronto');
});

test('importing the same file twice adds nothing and keeps edits', () => {
  const parsed = parseZkbCsv(csv(row('22.10.2026', `${CARD} SHOP`, 'L1', '5.00')));
  const first = applyImport([], parsed);
  assert.equal(first.added, 1);
  const edited = [{ ...first.items[0], category: 'Leisure', oneOff: true }];
  const again = applyImport(edited, parsed);
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 1);
  assert.equal(again.items[0].category, 'Leisure');
  assert.equal(again.items[0].oneOff, true);
});

test('a booked row replaces its pending row and inherits its edits', () => {
  const pending = parseZkbCsv(csv(row('30.10.2026', 'Purchase ZKB Visa Debit card No. xxxx 1234, SHOP', '', '5.00')));
  const held = [{ ...pending[0], category: 'Leisure' }];
  const booked = parseZkbCsv(csv(row('30.10.2026', `${CARD} SHOP`, 'L9', '5.00')));
  const res = applyImport(held, booked);
  assert.deepEqual(res.items.map((t) => [t.id, t.category]), [['zkb:L9', 'Leisure']]);
  assert.equal(res.removed, 1);
});

test('an older file neither drops newer pending rows nor brings back old ones', () => {
  const pending = parseZkbCsv(csv(row('30.10.2026', `${CARD} NEW`, '', '5.00')));
  const older = parseZkbCsv(csv(row('01.10.2026', `${CARD} OLD`, 'L1', '7.00')));
  assert.equal(applyImport(pending, older).items.length, 2);
  const booked = parseZkbCsv(csv(row('30.10.2026', `${CARD} NEW`, 'L2', '5.00')));
  const olderPending = parseZkbCsv(csv(row('01.10.2026', `${CARD} OLD`, '', '7.00')));
  assert.equal(applyImport(booked, olderPending).items.length, 1);
});

test('a hand-set category beats a rule, which beats the built-in list', () => {
  const tx = { key: 'coop pronto', merchant: 'Coop Pronto', raw: 'x', amount: -5, category: '' };
  assert.equal(categorise(tx), 'Groceries');
  const rules = [{ id: 'coop pronto', category: 'Car' }];
  assert.equal(categorise(tx, rules), 'Car');
  assert.equal(categorise({ ...tx, category: 'Leisure' }, rules), 'Leisure');
});

test('built-in list sorts specific merchants before general ones', () => {
  const cat = (merchant, amount = -1) => categorise({ key: merchantKey(merchant), merchant, raw: merchant, amount, category: '' });
  assert.equal(cat('UBER *EATS'), 'Eating out');
  assert.equal(cat('UBER'), 'Transport');
  assert.equal(cat('Unknown Shop'), UNCATEGORISED);
  assert.equal(cat('Unknown Payer', 10), 'Other income');
  assert.equal(kindOf('Savings'), 'saving');
  assert.equal(kindOf('Transfer'), 'transfer');
  assert.equal(kindOf('Groceries'), 'spend');
});

const tx = (date, merchant, amount, extra = {}) => ({ id: `${date}${merchant}${amount}${Math.random()}`, date, merchant, key: merchantKey(merchant), raw: merchant, amount, category: '', oneOff: false, ...extra });

test('monthly totals keep savings and transfers out of spending, and refunds lower it', () => {
  const txs = [
    tx('2026-09-01', 'Income', 1000, { category: 'Salary' }),
    tx('2026-09-02', 'Coop', -100),
    tx('2026-09-03', 'Coop', 10),
    tx('2026-09-04', 'finpension', -200),
    tx('2026-09-05', 'Me', -300, { category: 'Transfer' }),
    tx('2026-09-06', 'Air France', -500, { oneOff: true }),
  ];
  assert.deepEqual(monthSummary(txs), [{ month: '2026-09', income: 1000, spend: 590, saved: 200, transferred: 300, net: 210 }]);
  assert.equal(monthSummary(txs, [], { oneOffs: false })[0].spend, 90);
  assert.deepEqual(categoryTotals(txs).map((c) => [c.category, c.total]), [['Travel', 500], ['Groceries', 90]]);
});

test('complete months leave out a month cut off at the start and the current one', () => {
  const txs = [tx('2026-07-22', 'A', -1), tx('2026-08-10', 'A', -1), tx('2026-09-30', 'A', -1), tx('2026-10-02', 'A', -1)];
  assert.deepEqual(completeMonths(txs, '2026-10-31'), ['2026-08', '2026-09']);
  assert.deepEqual(completeMonths([tx('2026-07-02', 'A', -1), tx('2026-08-02', 'A', -1)], '2026-10-31'), ['2026-07', '2026-08']);
});

const everyMonth = (months, merchant, amount, n = 1) =>
  months.flatMap((m) => Array.from({ length: n }, (_, i) => tx(`${m}-${String(i + 2).padStart(2, '0')}`, merchant, amount)));
const QUARTER = ['2026-07', '2026-08', '2026-09'];
const HALF = ['2026-04', '2026-05', '2026-06', ...QUARTER];

test('no suggestions below three complete months', () => {
  const res = leaks(everyMonth(['2026-08', '2026-09'], 'Netflix', -20), [], '2026-10-31');
  assert.deepEqual(res, { ready: false, have: 2, need: 3, items: [] });
});

test('steady monthly charges are flagged, with yearly cost; rent and one-offs are not', () => {
  const txs = [
    ...everyMonth(QUARTER, 'Netflix', -20),
    ...everyMonth(QUARTER, 'Some Immobilien AG', -3000),
    ...everyMonth(QUARTER, 'Spotify', -15).map((t) => ({ ...t, oneOff: true })),
  ];
  const { ready, items } = leaks(txs, [], '2026-10-31');
  assert.equal(ready, true);
  assert.deepEqual(items.map((i) => [i.type, i.title, i.perMonth, i.perYear]), [['recurring', 'Netflix', 20, 240]]);
});

test('a charge that stopped, or varies a lot, is not a subscription', () => {
  const stopped = everyMonth(['2026-03', '2026-04', '2026-05'], 'Netflix', -20).concat(everyMonth(['2026-06', '2026-07', '2026-08', '2026-09'], 'Coop', -60));
  assert.deepEqual(leaks(stopped, [], '2026-10-31').items.filter((i) => i.title === 'Netflix'), []);
  const varied = [tx('2026-07-02', 'Decathlon', -20), tx('2026-08-02', 'Decathlon', -200), tx('2026-09-02', 'Decathlon', -90)];
  assert.deepEqual(leaks(varied, [], '2026-10-31').items, []);
});

test('frequent small purchases are flagged', () => {
  const { items } = leaks(everyMonth(QUARTER, 'Coop Pronto', -6, 5), [], '2026-10-31');
  assert.deepEqual(items.map((i) => [i.type, i.perMonth]), [['small', 30]]);
});

test('a category rising over 20% is flagged, below that it is not', () => {
  const rise = (later) => [...everyMonth(HALF.slice(0, 3), 'Shop A', -100), ...everyMonth(QUARTER, 'Shop B', -later)]
    .map((t) => ({ ...t, category: 'Shopping' }));
  const flagged = leaks(rise(150), [], '2026-10-31').items.filter((i) => i.type === 'creep');
  assert.deepEqual(flagged.map((i) => [i.title, i.perMonth]), [['Shopping', 50]]);
  assert.deepEqual(leaks(rise(110), [], '2026-10-31').items.filter((i) => i.type === 'creep'), []);
});

test('cleaners drop malformed records', () => {
  assert.equal(cleanTransactions([{ id: 'a', date: '2026-10-01', amount: '-5.5' }, { id: 'b', date: 'nope' }, null])[0].amount, -5.5);
  assert.equal(cleanTransactions([{ id: 'b', date: 'nope' }]).length, 0);
  assert.deepEqual(cleanRules([{ id: 'k', category: 'Car' }, { id: 'x' }]), [{ id: 'k', category: 'Car', createdAt: 0, updatedAt: 0 }]);
});
