import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime, resolveDate, validateRow, findConflicts,
  normalizeEvent, buildEventPayload, layoutOverlaps, rowsRange, addMinutes,
  occurrenceDates, firstOccurrence, buildRRule, describeRepeat, waitingAge, moveTask,
  stampTaskChanges, mergeTaskDocs, nestTask, removeTask, effectiveParentId, subtasksOf, taskBlockTitle,
  tasksById, alignSubtasks, mergeRecordDocs, habitDayState, canToggleDay, toggleCheck, habitStats, mergeHabit, isAvoid,
  heatmapWeeks, combinedDayState, groupByDay, countByDay, comboFromEvent, formatCombo, shortcutProblem,
  flairFor, flairUrl, buildEventPatch,
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

test('layoutOverlaps splits items that start together and stacks later ones over earlier ones', () => {
  const pos = (items) => items.map(({ left, width, depth }) => [left, width, depth]);
  // Alone: full width.
  assert.deepEqual(pos(layoutOverlaps([{ s: 0, e: 60 }])), [[0, 100, 0]]);
  // Start within 30 minutes of each other: side by side.
  assert.deepEqual(pos(layoutOverlaps([{ s: 600, e: 660 }, { s: 615, e: 700 }])), [[0, 50, 0], [50, 50, 0]]);
  // Starts an hour later inside the first: indented and drawn on top; the first keeps the full width.
  assert.deepEqual(pos(layoutOverlaps([{ s: 600, e: 720 }, { s: 660, e: 700 }])), [[0, 100, 0], [18, 82, 1]]);
  // Nested twice, then a separate item after the cluster.
  assert.deepEqual(pos(layoutOverlaps([{ s: 0, e: 300 }, { s: 60, e: 240 }, { s: 120, e: 180 }, { s: 400, e: 420 }])),
    [[0, 100, 0], [18, 82, 1], [36, 64, 2], [0, 100, 0]]);
  // Two items starting together inside a long one share the indented space.
  assert.deepEqual(pos(layoutOverlaps([{ s: 0, e: 300 }, { s: 120, e: 180 }, { s: 125, e: 200 }])),
    [[0, 100, 0], [18, 41, 1], [59, 41, 1]]);
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
  assert.equal(ids(moveTask(tasks, 'd', 'backlog', 'a', 1)), 'dabc');
  assert.equal(ids(moveTask(tasks, 'a', 'backlog', null, 1)), 'bcda');
  const w = moveTask(tasks, 'b', 'waiting', null, 42);
  assert.equal(ids(w), 'acdb');
  assert.equal(w.find((t) => t.id === 'b').waitingSince, 42);
  const d = moveTask(w, 'b', 'doing', 'c', 50);
  assert.equal(ids(d), 'abcd');
  assert.equal(d.find((t) => t.id === 'b').waitingSince, null);
  // Reordering inside Waiting keeps the original waitingSince.
  assert.equal(moveTask(w, 'b', 'waiting', null, 99).find((t) => t.id === 'b').waitingSince, 42);
  assert.equal(moveTask(tasks, 'a', 'done', null, 7).find((t) => t.id === 'a').doneAt, 7);
});

test('moveTask keeps a group in one lane', () => {
  const tasks = [
    { id: 'p', status: 'backlog' }, { id: 'x', status: 'backlog', parentId: 'p' },
    { id: 'y', status: 'backlog', parentId: 'p' }, { id: 'z', status: 'backlog' },
  ];
  const by = tasksById(moveTask(tasks, 'p', 'waiting', null, 9));
  assert.deepEqual(['p', 'x', 'y', 'z'].map((id) => by.get(id).status), ['waiting', 'waiting', 'waiting', 'backlog']);
  assert.equal(by.get('x').waitingSince, 9);
  const done = tasksById(moveTask(tasks, 'p', 'done', null, 7));
  assert.deepEqual([done.get('x').status, done.get('x').doneAt], ['done', 7]);
  // A subtask moved to another lane leaves the group; reordering in the lane keeps it.
  const out = tasksById(moveTask(tasks, 'x', 'doing', null, 5)).get('x');
  assert.deepEqual([out.status, out.parentId], ['doing', null]);
  assert.equal(moveTask(tasks, 'x', 'backlog', 'p', 5).find((t) => t.id === 'x').parentId, 'p');
  // Reordering the parent inside its lane leaves subtasks alone.
  assert.equal(moveTask(tasks, 'p', 'backlog', null, 9).find((t) => t.id === 'x'), tasks[1]);
});

test('alignSubtasks puts subtasks in the parent lane', () => {
  const tasks = [
    { id: 'p', status: 'waiting', waitingSince: 4 }, { id: 'x', status: 'backlog', parentId: 'p' },
    { id: 'y', status: 'waiting', parentId: 'p' }, { id: 'o', status: 'done', parentId: 'gone' },
  ];
  const out = alignSubtasks(tasks);
  assert.deepEqual([out[1].status, out[1].waitingSince], ['waiting', 4]);
  assert.equal(out[2], tasks[2]);
  assert.equal(out[3], tasks[3]);
  assert.equal(alignSubtasks(out), out);
});

test('nestTask nests one level deep and detaches', () => {
  const tasks = [
    { id: 'p', status: 'doing' }, { id: 'c', status: 'doing', parentId: 'p' },
    { id: 'a', status: 'backlog' }, { id: 'b', status: 'backlog' },
  ];
  const ids = (ts) => ts.map((t) => t.id).join('');
  const n = nestTask(tasks, 'b', 'p');
  assert.equal(ids(n), 'pcba');
  const b = n.find((t) => t.id === 'b');
  assert.deepEqual([b.parentId, b.status], ['p', 'doing']);
  assert.equal(nestTask(tasks, 'a', 'c'), tasks, 'no subtask of a subtask');
  assert.equal(nestTask(tasks, 'p', 'a'), tasks, 'a task with subtasks stays top-level');
  assert.equal(nestTask(tasks, 'a', 'a'), tasks);
  const out = nestTask(tasks, 'c', null);
  assert.equal(out.find((t) => t.id === 'c').parentId, null);
  assert.equal(nestTask(tasks, 'a', null), tasks);
  // A nested task joins its parent's lane.
  const done = [{ id: 'p', status: 'done', doneAt: 3 }, { id: 'a', status: 'backlog' }];
  const joined = nestTask(done, 'a', 'p')[1];
  assert.deepEqual([joined.status, joined.doneAt], ['done', 3]);
});

test('removeTask removes subtasks too', () => {
  const tasks = [{ id: 'p' }, { id: 'c', parentId: 'p' }, { id: 'a' }];
  assert.deepEqual(removeTask(tasks, 'p').map((t) => t.id), ['a']);
  assert.deepEqual(removeTask(tasks, 'c').map((t) => t.id), ['p', 'a']);
});

test('effectiveParentId ignores missing parents and cycles', () => {
  const tasks = [
    { id: 'p', title: 'Plan' }, { id: 'c', title: 'Call', parentId: 'p' }, { id: 'o', parentId: 'gone' },
    { id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' },
  ];
  const by = tasksById(tasks);
  assert.deepEqual(tasks.map((t) => effectiveParentId(t, by)), [null, 'p', null, null, null]);
  assert.deepEqual(subtasksOf(tasks, 'p').map((t) => t.id), ['c']);
  assert.equal(taskBlockTitle(by.get('c'), by), 'Plan: Call');
  assert.equal(taskBlockTitle(by.get('p'), by), 'Plan');
});

test('stampTaskChanges marks edited tasks, removals and reorders', () => {
  const a = { id: 'a', title: 'A', status: 'backlog', updatedAt: 1 };
  const b = { id: 'b', title: 'B', status: 'backlog', updatedAt: 1 };
  const same = stampTaskChanges([a, b], [a, b], 50);
  assert.deepEqual([same.tasks[0], same.removed, same.reordered], [a, [], false]);
  const edited = stampTaskChanges([a, b], [{ ...a, title: 'A2' }, b], 50);
  assert.equal(edited.tasks[0].updatedAt, 50);
  assert.equal(edited.tasks[1], b);
  assert.deepEqual(stampTaskChanges([a, b], [b], 50).removed, ['a']);
  assert.equal(stampTaskChanges([a, b], [b, a], 50).reordered, true);
  const c = { id: 'c', title: 'C', status: 'backlog' };
  const added = stampTaskChanges([a, b], [a, c, b], 50);
  assert.equal(added.reordered, false);
  assert.equal(added.tasks[1].updatedAt, 50);
});

test('mergeTaskDocs keeps the newest edit, honours deletions and unions both boards', () => {
  const now = 1_000_000;
  const t = (id, updatedAt, extra = {}) => ({ id, title: id, status: 'backlog', createdAt: 1, updatedAt, ...extra });
  const local = { tasks: [t('a', 10), t('b', 20, { title: 'local' }), t('gone', 5)], deleted: {}, orderedAt: 100 };
  const remote = { tasks: [t('b', 30, { title: 'remote' }), t('c', 10)], deleted: { gone: 6 }, orderedAt: 50 };
  const m = mergeTaskDocs(local, remote, now);
  assert.deepEqual(m.tasks.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(m.tasks[1].title, 'remote');
  assert.equal(m.tasks[0], local.tasks[0]);
  assert.deepEqual(m.deleted, { gone: 6 });
  assert.equal(m.orderedAt, 100);
  // An edit made after the deletion brings the task back.
  assert.deepEqual(mergeTaskDocs({ tasks: [t('x', 9)] }, { tasks: [], deleted: { x: 8 } }, now).tasks.map((x) => x.id), ['x']);
  // The board rearranged last decides the order.
  const o = mergeTaskDocs({ tasks: [t('a', 1), t('b', 1)], orderedAt: 1 }, { tasks: [t('b', 1), t('a', 1)], orderedAt: 2 }, now);
  assert.deepEqual(o.tasks.map((x) => x.id), ['b', 'a']);
  // Old tombstones are forgotten; tasks without updatedAt fall back to createdAt.
  assert.deepEqual(mergeTaskDocs({ tasks: [], deleted: { z: 1 } }, null, now + 100 * 86_400_000).deleted, {});
  assert.equal(mergeTaskDocs({ tasks: [{ id: 'y', createdAt: 5 }] }, { tasks: [], deleted: { y: 4 } }, now).tasks.length, 1);
});

test('mergeTaskDocs carries parentId', () => {
  const t = { id: 'c', title: 'c', status: 'backlog', parentId: 'p', updatedAt: 5 };
  assert.equal(mergeTaskDocs({ tasks: [] }, { tasks: [t] }, 10).tasks[0].parentId, 'p');
});

const habit = (checked, start = '2026-09-20') => ({
  id: 'h', title: 'x', start, checks: Object.fromEntries(checked.map((d) => [d, { on: true, at: 1 }])),
});

test('habitDayState: done, broken, pending today, before start', () => {
  const hb = habit(['2026-09-25']);
  assert.equal(habitDayState(hb, '2026-09-19', TODAY), 'before');
  assert.equal(habitDayState(hb, '2026-09-25', TODAY), 'done');
  assert.equal(habitDayState(hb, '2026-09-26', TODAY), 'broken');
  assert.equal(habitDayState(hb, TODAY, TODAY), 'pending');
  assert.equal(habitDayState(hb, '2026-09-28', TODAY), 'future');
});

test('canToggleDay allows today and yesterday only', () => {
  const hb = habit([]);
  assert.ok(canToggleDay(hb, TODAY, TODAY));
  assert.ok(canToggleDay(hb, '2026-09-26', TODAY));
  assert.ok(!canToggleDay(hb, '2026-09-25', TODAY));
  assert.ok(!canToggleDay(hb, '2026-09-28', TODAY));
  assert.ok(!canToggleDay(habit([], TODAY), '2026-09-26', TODAY)); // before the habit existed
});

test('toggleCheck flips a day and stamps it', () => {
  const on = toggleCheck(habit([]), TODAY, 5);
  assert.deepEqual(on.checks[TODAY], { on: true, at: 5 });
  assert.deepEqual(toggleCheck(on, TODAY, 6).checks[TODAY], { on: false, at: 6 });
});

test('habitStats: streak survives an unchecked today, resets on a miss', () => {
  // 20..23 done, 24 missed, 25..26 done, today open
  const hb = habit(['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-25', '2026-09-26']);
  assert.deepEqual(habitStats(hb, TODAY), { current: 2, best: 4, broken: 1, done: 6 });
  assert.equal(habitStats(toggleCheck(hb, TODAY, 1), TODAY).current, 3);
  assert.equal(habitStats(habit(['2026-09-25']), TODAY).current, 0); // yesterday missed
  assert.deepEqual(habitStats(habit([], TODAY), TODAY), { current: 0, best: 0, broken: 0, done: 0 });
});

test('mergeHabit keeps the newer fields and merges check-ins per day', () => {
  const a = { id: 'h', title: 'old', updatedAt: 1, checks: { d1: { on: true, at: 10 }, d2: { on: true, at: 10 } } };
  const b = { id: 'h', title: 'new', updatedAt: 2, checks: { d2: { on: false, at: 20 }, d3: { on: true, at: 5 } } };
  const m = mergeHabit(a, b);
  assert.equal(m.title, 'new');
  assert.deepEqual(m.checks, { d1: { on: true, at: 10 }, d2: { on: false, at: 20 }, d3: { on: true, at: 5 } });
  assert.deepEqual(mergeHabit(b, a), m);
});

test('mergeRecordDocs unions, honours deletions and combines shared records', () => {
  const now = 1_000_000;
  const a = { items: [{ id: '1', updatedAt: 1 }, { id: '2', updatedAt: 1 }], deleted: {} };
  const b = { items: [{ id: '2', updatedAt: 2, v: 'b' }, { id: '3', updatedAt: 1 }], deleted: { 1: 5 } };
  const m = mergeRecordDocs(a, b, now);
  assert.deepEqual(m.items.map((x) => x.id), ['2', '3']);
  assert.equal(m.items[0].v, 'b');
  assert.deepEqual(m.deleted, { 1: 5 });
  const c = mergeRecordDocs(a, b, now, (x, y) => ({ ...x, both: true }));
  assert.ok(c.items.find((x) => x.id === '2').both);
});

test('heatmapWeeks ends with the week holding today, Monday first', () => {
  const w = heatmapWeeks(TODAY, 3); // TODAY is a Sunday
  assert.equal(w.length, 3);
  assert.equal(w[2][0], '2026-09-21');
  assert.equal(w[2][6], TODAY);
  assert.equal(w[0][0], '2026-09-07');
});

test('groupByDay: newest first, across and inside days', () => {
  const at = (s) => new Date(s).getTime();
  const g = groupByDay([
    { id: 'a', at: at('2026-09-26T10:00') }, { id: 'b', at: at('2026-09-27T09:00') }, { id: 'c', at: at('2026-09-26T08:00') },
  ]);
  assert.deepEqual(g.map((d) => d.date), ['2026-09-27', '2026-09-26']);
  assert.deepEqual(g[1].items.map((e) => e.id), ['a', 'c']);
});

test('comboFromEvent uses the physical key', () => {
  assert.equal(comboFromEvent({ code: 'KeyD', key: 'D', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+D');
  assert.equal(comboFromEvent({ code: 'KeyD', key: '∂', metaKey: true, altKey: true }), 'Alt+Meta+D'); // Option on a Mac
  assert.equal(comboFromEvent({ code: 'ShiftLeft', key: 'Shift', shiftKey: true }), '');
  assert.equal(comboFromEvent({ code: 'F2', key: 'F2' }), 'F2');
  assert.equal(comboFromEvent({ code: 'Space', key: ' ', ctrlKey: true }), 'Ctrl+Space');
});

test('formatCombo shows Mac symbols', () => {
  assert.equal(formatCombo('Meta+Shift+D', true), '⌘⇧D');
  assert.equal(formatCombo('Ctrl+Shift+D', false), 'Ctrl+Shift+D');
});

test('shortcutProblem rejects bare keys and browser shortcuts', () => {
  assert.equal(shortcutProblem('Ctrl+Shift+G'), '');
  assert.equal(shortcutProblem('Meta+Shift+G'), '');
  assert.equal(shortcutProblem('F2'), '');
  assert.ok(shortcutProblem('D'));
  assert.ok(shortcutProblem('Shift+D'));
  assert.ok(shortcutProblem('Ctrl+T'));
  assert.ok(shortcutProblem('Meta+Q'));
  assert.ok(shortcutProblem(''));
});

test('combinedDayState summarises all habits on a day', () => {
  const a = habit(['2026-09-25', '2026-09-26']);
  const b = { ...habit(['2026-09-26'], '2026-09-25'), id: 'b' };
  assert.equal(combinedDayState([a, b], '2026-09-21', TODAY).state, 'broken'); // only a existed, and missed it
  assert.equal(combinedDayState([a, b], '2026-09-19', TODAY).state, 'before');
  const d25 = combinedDayState([a, b], '2026-09-25', TODAY);
  assert.equal(d25.state, 'broken');
  assert.deepEqual(d25.broken.map((x) => x.id), ['b']);
  assert.equal(d25.total, 2);
  assert.equal(combinedDayState([a, b], '2026-09-26', TODAY).state, 'done');
  assert.equal(combinedDayState([a, b], TODAY, TODAY).state, 'pending');
  assert.equal(combinedDayState([toggleCheck(a, TODAY, 1), toggleCheck(b, TODAY, 1)], TODAY, TODAY).state, 'done');
  assert.equal(combinedDayState([a], '2026-09-28', TODAY).state, 'future');
});

const avoid = (slipped, start = '2026-09-20') => ({ ...habit(slipped, start), kind: 'avoid' });

test('habitDayState: an avoid habit breaks on a tick and is kept otherwise', () => {
  const hb = avoid(['2026-09-25']);
  assert.ok(isAvoid(hb) && !isAvoid(habit([])));
  assert.equal(habitDayState(hb, '2026-09-19', TODAY), 'before');
  assert.equal(habitDayState(hb, '2026-09-25', TODAY), 'broken');
  assert.equal(habitDayState(hb, '2026-09-26', TODAY), 'done');
  assert.equal(habitDayState(hb, TODAY, TODAY), 'pending');
  assert.equal(habitDayState(toggleCheck(hb, TODAY, 1), TODAY, TODAY), 'broken');
  assert.equal(habitDayState(hb, '2026-09-28', TODAY), 'future');
});

test('habitStats: an avoid habit streak counts clean days and resets on a slip', () => {
  // 20..22 clean, 23 slipped, 24..26 clean, today open
  const hb = avoid(['2026-09-23']);
  assert.deepEqual(habitStats(hb, TODAY), { current: 3, best: 3, broken: 1, done: 6 });
  assert.deepEqual(habitStats(toggleCheck(hb, TODAY, 1), TODAY), { current: 0, best: 3, broken: 2, done: 6 });
  assert.deepEqual(habitStats(avoid([], TODAY), TODAY), { current: 0, best: 0, broken: 0, done: 0 });
});

test('combinedDayState mixes do and avoid habits', () => {
  const a = habit(['2026-09-26']);
  const b = { ...avoid(['2026-09-25']), id: 'b' };
  assert.deepEqual(combinedDayState([a, b], '2026-09-25', TODAY).broken.map((x) => x.id), ['h', 'b']);
  assert.equal(combinedDayState([a, b], '2026-09-26', TODAY).state, 'done');
  assert.equal(combinedDayState([toggleCheck(a, TODAY, 1), b], TODAY, TODAY).state, 'pending'); // the avoid habit can still slip
});

test('countByDay counts entries per local day', () => {
  const at = (d, t) => new Date(`${d}T${t}`).getTime();
  assert.deepEqual(countByDay([
    { at: at('2026-09-27', '09:00') }, { at: at('2026-09-27', '23:59') }, { at: at('2026-09-26', '00:00') },
  ]), { '2026-09-27': 2, '2026-09-26': 1 });
  assert.deepEqual(countByDay([]), {});
});

test('normalizeEvent uses the event colour and keeps details', () => {
  const n = normalizeEvent(ev({
    colorId: '11', location: 'Hall', hangoutLink: 'https://meet.google.com/abc',
    organizer: { email: 'boss@x.com' }, recurringEventId: 'series1',
    attendees: [{ email: 'me@x.com', self: true, responseStatus: 'accepted' }, { email: 'room@x.com', resource: true }],
  }), { ...cal, accessRole: 'owner' });
  assert.equal(n.color, '#d50000');
  assert.equal(n.details.location, 'Hall');
  assert.equal(n.details.video, 'https://meet.google.com/abc');
  assert.equal(n.details.attendees.length, 1);
  assert.equal(n.details.recurringEventId, 'series1');
  assert.equal(n.details.canEdit, false); // someone else's invitation
  assert.equal(n.details.canDelete, true);
  const own = normalizeEvent(ev({ organizer: { self: true } }), { ...cal, accessRole: 'writer' });
  assert.equal(own.color, cal.color);
  assert.equal(own.details.canEdit, true);
  assert.equal(normalizeEvent(ev(), { ...cal, accessRole: 'reader' }).details.canDelete, false);
});

test('flairFor matches whole words in any case', () => {
  assert.equal(flairFor('Concert at the park'), 'concert');
  assert.equal(flairFor('Sam’s BDAY'), 'birthday');
  assert.equal(flairFor('Play tennis'), 'tennis');
  assert.equal(flairFor('Dîner chez Paul'), 'dinner');
  assert.equal(flairFor('Starting the report'), ''); // "art" inside a word
  assert.equal(flairFor('Standup'), '');
  assert.match(flairUrl('concert'), /^https:\/\/ssl\.gstatic\.com\/.*\/img_concert\.jpg$/);
});

test('buildEventPatch sends only what changed', () => {
  const e = normalizeEvent(ev({ organizer: { self: true } }), cal);
  const base = { title: e.title, location: '', startDate: TODAY, endDate: TODAY, startTime: L_hm(e.start), endTime: L_hm(e.end) };
  assert.deepEqual(buildEventPatch(base, e, 'Europe/Paris'), { patch: {} });
  const moved = buildEventPatch({ ...base, title: 'New', startTime: '11', endTime: '11:30' }, e, 'Europe/Paris').patch;
  assert.equal(moved.summary, 'New');
  assert.deepEqual(moved.start, { dateTime: `${TODAY}T11:00:00`, timeZone: 'Europe/Paris' });
  assert.ok(buildEventPatch({ ...base, endTime: '08:00' }, e, 'UTC').error);
  assert.ok(buildEventPatch({ ...base, title: ' ' }, e, 'UTC').error);
  assert.equal(buildEventPatch({ ...base, description: 'hi' }, e, 'UTC').patch.description, 'hi');

  const allDay = normalizeEvent(ev({ start: { date: TODAY }, end: { date: '2026-09-28' } }), cal, { includeAllDay: true });
  const one = { title: allDay.title, location: '', startDate: TODAY, endDate: TODAY };
  assert.deepEqual(buildEventPatch(one, allDay, 'UTC'), { patch: {} });
  assert.deepEqual(buildEventPatch({ ...one, endDate: '2026-09-29' }, allDay, 'UTC').patch.end, { date: '2026-09-30' });
});

const L_hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
