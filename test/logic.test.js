import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime, resolveDate, validateRow, findConflicts,
  normalizeEvent, buildEventPayload, assignLanes, rowsRange, addMinutes,
  occurrenceDates, firstOccurrence, buildRRule, describeRepeat, waitingAge, moveTask,
} from '../js/logic.js';

const TODAY = '2026-09-27'; // a Sunday

test('parseTime accepts loose formats', () => {
  assert.equal(parseTime('9'), '09:00');
  assert.equal(parseTime('930'), '09:30');
  assert.equal(parseTime('9:30'), '09:30');
  assert.equal(parseTime('09.30'), '09:30');
  assert.equal(parseTime('9am'), '09:00');
  assert.equal(parseTime('9:30 pm'), '21:30');
  assert.equal(parseTime('12am'), '00:00');
  assert.equal(parseTime('12pm'), '12:00');
  assert.equal(parseTime('21:15'), '21:15');
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('9:75'), null);
  assert.equal(parseTime('13pm'), null);
  assert.equal(parseTime('abc'), null);
});

test('resolveDate handles keywords, offsets and weekdays', () => {
  assert.equal(resolveDate('today', TODAY), '2026-09-27');
  assert.equal(resolveDate('tomorrow', TODAY), '2026-09-28');
  assert.equal(resolveDate('+3', TODAY), '2026-09-30');
  assert.equal(resolveDate('mon', TODAY), '2026-09-28');
  assert.equal(resolveDate('Sunday', TODAY), '2026-09-27');
  assert.equal(resolveDate('2026-10-01', TODAY), '2026-10-01');
  assert.equal(resolveDate('2026-02-30', TODAY), null);
  assert.equal(resolveDate('month', TODAY), null);
});

test('validateRow', () => {
  assert.deepEqual(validateRow({ title: 'x', date: TODAY, start: '09:00', end: '10:00' }), []);
  assert.deepEqual(validateRow({ title: ' ', date: TODAY, start: '09:00', end: '10:00' }), ['Missing title']);
  assert.deepEqual(validateRow({ title: 'x', date: TODAY, start: '10:00', end: '10:00' }), ['End must be after start']);
  assert.ok(validateRow({ title: 'x', date: '', start: '', end: '' }).length >= 3);
});

const cal = { id: 'primary', name: 'Primary', color: '#000' };
const ev = (over) => ({
  id: 'e', summary: 'Standup', status: 'confirmed',
  start: { dateTime: '2026-09-27T09:30:00' }, end: { dateTime: '2026-09-27T10:00:00' },
  ...over,
});

test('normalizeEvent filters free, declined, cancelled and all-day events', () => {
  assert.ok(normalizeEvent(ev(), cal));
  assert.equal(normalizeEvent(ev({ transparency: 'transparent' }), cal), null);
  assert.equal(normalizeEvent(ev({ status: 'cancelled' }), cal), null);
  assert.equal(normalizeEvent(ev({ attendees: [{ self: true, responseStatus: 'declined' }] }), cal), null);
  assert.ok(normalizeEvent(ev({ attendees: [{ self: true, responseStatus: 'accepted' }] }), cal));
  const allDay = ev({ start: { date: '2026-09-27' }, end: { date: '2026-09-28' } });
  assert.equal(normalizeEvent(allDay, cal), null);
  const n = normalizeEvent(allDay, cal, { includeAllDay: true });
  assert.ok(n.allDay);
  assert.equal(n.end - n.start, 24 * 3600 * 1000);
});

test('findConflicts: events, touching edges, intra-batch, invalid rows', () => {
  const events = [normalizeEvent(ev(), cal)];
  const rows = [
    { id: 'a', title: 'A', date: TODAY, start: '09:00', end: '09:30' }, // touches standup: ok
    { id: 'b', title: 'B', date: TODAY, start: '09:45', end: '11:00' }, // overlaps standup + c
    { id: 'c', title: 'C', date: TODAY, start: '10:30', end: '12:00' }, // overlaps b
    { id: 'd', title: 'D', date: TODAY, start: '12:00', end: '11:00' }, // invalid
    { id: 'e', title: 'E', date: '2026-09-28', start: '09:45', end: '10:00' }, // other day
  ];
  const c = findConflicts(rows, events);
  assert.deepEqual(c.get('a'), []);
  assert.deepEqual(c.get('b').map((x) => x.kind), ['event', 'row']);
  assert.equal(c.get('b')[1].index, 2);
  assert.deepEqual(c.get('c').map((x) => x.index), [1]);
  assert.equal(c.has('d'), false);
  assert.deepEqual(c.get('e'), []);
});

test('rowsRange spans valid rows only', () => {
  const r = rowsRange([
    { title: 'A', date: TODAY, start: '09:00', end: '10:00' },
    { title: 'B', date: '2026-09-28', start: '13:00', end: '14:00' },
    { title: '', date: '2026-09-30', start: '13:00', end: '14:00' },
  ]);
  assert.equal(r.start.getTime(), new Date('2026-09-27T09:00:00').getTime());
  assert.equal(r.end.getTime(), new Date('2026-09-28T14:00:00').getTime());
  assert.equal(rowsRange([]), null);
});

test('buildEventPayload', () => {
  const p = buildEventPayload({ title: ' Deep work ', date: TODAY, start: '09:00', end: '10:30' }, 'Asia/Ho_Chi_Minh');
  assert.deepEqual(p.start, { dateTime: '2026-09-27T09:00:00', timeZone: 'Asia/Ho_Chi_Minh' });
  assert.equal(p.summary, 'Deep work');
  assert.equal(p.extendedProperties.private.source, 'time-block-app');
});

test('assignLanes places overlapping items side by side', () => {
  const items = [{ s: 0, e: 60 }, { s: 30, e: 90 }, { s: 60, e: 120 }, { s: 200, e: 210 }];
  assignLanes(items);
  assert.deepEqual(items.map((i) => i.lane), [0, 1, 0, 0]);
  assert.deepEqual(items.map((i) => i.lanes), [2, 2, 2, 1]);
});

test('addMinutes clamps to end of day', () => {
  assert.equal(addMinutes('09:30', 60), '10:30');
  assert.equal(addMinutes('23:30', 60), '23:59');
});

test('validateRow reports unreadable times', () => {
  assert.deepEqual(
    validateRow({ title: 'x', date: TODAY, start: 'soon', end: '10:00' }),
    ['Can\'t read start time "soon"'],
  );
});

// ---------------------------------------------------------------- recurrence
// TODAY (2026-09-27) is a Sunday.
const rep = (freq, days = [], until = '') => ({ freq, days, until });
const recRow = (over) => ({ id: 'r', title: 'R', date: TODAY, start: '09:00', end: '10:00', ...over });

test('occurrenceDates: daily / weekdays / weekly with 28-day horizon', () => {
  const daily = occurrenceDates(recRow({ repeat: rep('daily') }));
  assert.equal(daily.length, 28);
  assert.equal(daily[0], '2026-09-27');
  assert.equal(daily[27], '2026-10-24');
  const wd = occurrenceDates(recRow({ repeat: rep('weekdays') }));
  assert.equal(wd.length, 20);
  assert.equal(wd[0], '2026-09-28'); // Sunday start is skipped
  const wk = occurrenceDates(recRow({ repeat: rep('weekly', [1, 3]) }));
  assert.deepEqual(wk.slice(0, 3), ['2026-09-28', '2026-09-30', '2026-10-05']);
  assert.equal(wk.length, 8);
  assert.deepEqual(occurrenceDates(recRow({ repeat: rep('') })), [TODAY]);
});

test('occurrenceDates respects until (inclusive) beyond the horizon', () => {
  const d = occurrenceDates(recRow({ repeat: rep('weekly', [5], '2026-12-25') }));
  assert.equal(d[d.length - 1], '2026-12-25');
  assert.equal(d.length, 13);
  assert.deepEqual(occurrenceDates(recRow({ repeat: rep('daily', [], '2026-09-28') })), ['2026-09-27', '2026-09-28']);
});

test('firstOccurrence moves the series start to the first matching day', () => {
  assert.equal(firstOccurrence(recRow({ repeat: rep('weekdays') })), '2026-09-28');
  assert.equal(firstOccurrence(recRow({ repeat: rep('weekly', [3]) })), '2026-09-30');
  assert.equal(firstOccurrence(recRow({ repeat: rep('daily') })), TODAY);
});

test('buildRRule', () => {
  assert.equal(buildRRule(rep('daily')), 'RRULE:FREQ=DAILY');
  assert.equal(buildRRule(rep('weekdays')), 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(buildRRule(rep('weekly', [0, 5, 1])), 'RRULE:FREQ=WEEKLY;BYDAY=MO,FR,SU');
  const until = new Date('2026-12-20T23:59:59').toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.equal(buildRRule(rep('daily', [], '2026-12-20')), `RRULE:FREQ=DAILY;UNTIL=${until}`);
  assert.match(until, /^\d{8}T\d{6}Z$/);
});

test('describeRepeat', () => {
  assert.equal(describeRepeat(rep('weekly', [3, 1])), 'Weekly on Mon, Wed');
  assert.equal(describeRepeat(rep('weekdays')), 'Every weekday');
});

test('validateRow checks repeat rules', () => {
  assert.deepEqual(validateRow(recRow({ repeat: rep('weekly', []) })), ['Pick at least one day']);
  assert.deepEqual(validateRow(recRow({ repeat: rep('daily', [], '2026-09-01') })), ['Repeat end is before start']);
  assert.deepEqual(validateRow(recRow({ repeat: rep('weekdays', [], TODAY) })), ['No matching days before the end date']);
  assert.deepEqual(validateRow(recRow({ repeat: rep('weekdays') })), []);
});

test('findConflicts expands recurring rows and reports the occurrence date', () => {
  const standupOct1 = normalizeEvent(ev({
    start: { dateTime: '2026-10-01T09:30:00' }, end: { dateTime: '2026-10-01T10:00:00' },
  }), cal);
  const rows = [
    recRow({ id: 'a', repeat: rep('weekdays') }),
    recRow({ id: 'b', date: '2026-10-06', start: '09:45', end: '10:15', repeat: rep('') }),
  ];
  const c = findConflicts(rows, [standupOct1]);
  assert.deepEqual(c.get('a').map((x) => [x.kind, x.occDate]), [['event', '2026-10-01'], ['row', '2026-10-06']]);
  assert.deepEqual(c.get('b').map((x) => [x.kind, x.occDate]), [['row', '2026-10-06']]);
});

test('rowsRange spans every checked occurrence', () => {
  const r = rowsRange([recRow({ repeat: rep('weekdays') })]);
  assert.equal(r.start.getTime(), new Date('2026-09-28T09:00:00').getTime());
  assert.equal(r.end.getTime(), new Date('2026-10-23T10:00:00').getTime());
});

test('buildEventPayload for a recurring row', () => {
  const p = buildEventPayload(recRow({ repeat: rep('weekly', [3], '2026-12-31') }), 'Europe/Zurich');
  assert.equal(p.start.dateTime, '2026-09-30T09:00:00');
  assert.equal(p.end.dateTime, '2026-09-30T10:00:00');
  assert.equal(p.recurrence.length, 1);
  assert.match(p.recurrence[0], /^RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=\d{8}T\d{6}Z$/);
  assert.equal(buildEventPayload(recRow({ repeat: rep('') }), 'UTC').recurrence, undefined);
});

test('waitingAge picks a compact unit', () => {
  const m = 60000;
  assert.equal(waitingAge(0, 5 * m), '5m');
  assert.equal(waitingAge(0, 3 * 60 * m), '3h');
  assert.equal(waitingAge(0, 2 * 24 * 60 * m), '2d');
  assert.equal(waitingAge(0, 13 * 24 * 60 * m), '13d');
  assert.equal(waitingAge(0, 22 * 24 * 60 * m), '3w');
  assert.equal(waitingAge(10 * m, 0), '0m');
});

test('moveTask reorders within and across lanes and stamps times', () => {
  const tasks = [
    { id: 'a', status: 'backlog' }, { id: 'b', status: 'backlog' },
    { id: 'c', status: 'doing' }, { id: 'd', status: 'backlog' },
  ];
  const ids = (ts) => ts.map((t) => t.id).join('');
  assert.equal(ids(moveTask(tasks, 'd', 'backlog', 0, 1)), 'dabc');
  assert.equal(ids(moveTask(tasks, 'a', 'backlog', 9, 1)), 'bcda');
  const w = moveTask(tasks, 'b', 'waiting', 0, 42);
  assert.equal(ids(w), 'acdb');
  assert.equal(w.find((t) => t.id === 'b').waitingSince, 42);
  const d = moveTask(w, 'b', 'doing', 0, 50);
  assert.equal(ids(d), 'abcd');
  assert.equal(d.find((t) => t.id === 'b').waitingSince, null);
  // Reordering inside Waiting keeps the original waitingSince.
  assert.equal(moveTask(w, 'b', 'waiting', 0, 99).find((t) => t.id === 'b').waitingSince, 42);
  assert.equal(moveTask(tasks, 'a', 'done', 0, 7).find((t) => t.id === 'a').doneAt, 7);
});
