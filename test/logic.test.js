import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime, resolveDate, parseQuickText, validateRow, findConflicts,
  normalizeEvent, buildEventPayload, assignLanes, rowsRange, addMinutes,
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

test('parseQuickText parses lines, date headers and reports errors', () => {
  const text = [
    '9:00-10:30 Deep work',
    '- 10:30 to 11 Email',
    'tomorrow',
    '9am-10am Gym',
    '2026-10-01 14:00–15:00 Review PRs',
    'garbage line',
    '',
  ].join('\n');
  const { rows, errors } = parseQuickText(text, TODAY, TODAY);
  assert.deepEqual(rows, [
    { title: 'Deep work', date: '2026-09-27', start: '09:00', end: '10:30' },
    { title: 'Email', date: '2026-09-27', start: '10:30', end: '11:00' },
    { title: 'Gym', date: '2026-09-28', start: '09:00', end: '10:00' },
    { title: 'Review PRs', date: '2026-10-01', start: '14:00', end: '15:00' },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 6);
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
