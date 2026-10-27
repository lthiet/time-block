import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROGRAMS, cleanPrograms, cleanSessions, cleanWeighins, todaysProgram, exerciseSessions, maxWeight,
  setsToText, textToSets, sessionsFromInputs, upsert, rangeCutoff, inRange, emaTrend,
  fromIronLog, mergeImport, combineIronLog, progressGroups,
} from '../js/fitness-logic.js';

test('cleaners drop malformed records and key sessions and weigh-ins', () => {
  assert.deepEqual(cleanWeighins([{ date: '2026-10-01', weight: '80.5' }, { date: 'bad', weight: 1 }, null]),
    [{ id: '2026-10-01', date: '2026-10-01', weight: 80.5, createdAt: 0, updatedAt: 0 }]);
  const s = cleanSessions([{ ex: 'bench', date: '2026-10-01', sets: [{ weight: 80, reps: 5 }, { weight: '', reps: 3 }] }, { date: '2026-10-01' }]);
  assert.equal(s.length, 1);
  assert.equal(s[0].id, 'bench@2026-10-01');
  assert.deepEqual(s[0].sets, [{ weight: '80', reps: '5' }]);
  const p = cleanPrograms([{ id: 'a', name: 'A', exercises: [{ id: 'x', name: 'X' }, {}] }, { name: 'no id' }]);
  assert.deepEqual(p.map((x) => [x.id, x.order, x.exercises.length]), [['a', 0, 1]]);
});

test('todaysProgram matches the split day named after the weekday', () => {
  assert.equal(todaysProgram(DEFAULT_PROGRAMS, '2026-10-27'), 0); // a Tuesday
  assert.equal(todaysProgram(DEFAULT_PROGRAMS, '2026-10-29'), 1); // a Thursday
  assert.equal(todaysProgram(DEFAULT_PROGRAMS, '2026-10-28'), -1);
});

test('sets round-trip through text', () => {
  const sets = [{ weight: '75', reps: '5' }, { weight: '80.5', reps: '3' }];
  assert.equal(setsToText(sets), '75×5 / 80.5×3');
  assert.deepEqual(textToSets('75×5 / 80.5x3 / junk / 90 * 1'), [...sets, { weight: '90', reps: '1' }]);
  assert.equal(maxWeight(sets), 80.5);
});

test('sessionsFromInputs keeps exercises with a complete set', () => {
  const out = sessionsFromInputs({ bench: [{ weight: '80', reps: '5' }, { weight: '85', reps: '' }], squat: [{ weight: '', reps: '' }] }, '2026-10-27');
  assert.deepEqual(out, [{ id: 'bench@2026-10-27', ex: 'bench', date: '2026-10-27', sets: [{ weight: '80', reps: '5' }] }]);
  const merged = upsert([{ id: 'bench@2026-10-27', sets: [] }, { id: 'other' }], out);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].sets.length, 1);
  assert.deepEqual(exerciseSessions([{ ex: 'a', date: '2026-02-01' }, { ex: 'b', date: '2026-01-01' }, { ex: 'a', date: '2026-01-01' }], 'a').map((x) => x.date), ['2026-01-01', '2026-02-01']);
});

test('ranges cut off by calendar months', () => {
  assert.equal(rangeCutoff('1m', '2026-10-27'), '2026-09-27');
  assert.equal(rangeCutoff('1y', '2026-10-27'), '2025-10-27');
  assert.equal(rangeCutoff('all', '2026-10-27'), null);
  const e = [{ date: '2026-01-01' }, { date: '2026-10-01' }];
  assert.equal(inRange(e, '3m', '2026-10-27').length, 1);
  assert.equal(inRange(e, 'all', '2026-10-27').length, 2);
});

test('emaTrend needs three points and follows real elapsed days', () => {
  assert.equal(emaTrend([{ date: '2026-01-01', weight: 80 }, { date: '2026-01-02', weight: 81 }]), null);
  const t = emaTrend([{ date: '2026-01-01', weight: 80 }, { date: '2026-01-02', weight: 82 }, { date: '2026-06-01', weight: 70 }]);
  assert.equal(t[0], 80);
  assert.ok(t[1] > 80 && t[1] < 81);
  assert.ok(Math.abs(t[2] - 70) < 0.01); // a long gap meets the new reading
});

test('fromIronLog reads arrays and Firebase-style objects', () => {
  const out = fromIronLog({
    programs: { 0: { id: 'tue', name: 'Tuesday', exercises: { 0: { id: 'bench', name: 'Bench' } } } },
    history: { bench: { 0: { date: '2026-09-01', sets: { 0: { weight: '80', reps: '5' } } } } },
    bodyweight: [{ date: '2026-09-01', weight: 79.2 }],
  });
  assert.deepEqual(out.programs.map((p) => [p.id, p.exercises[0].id]), [['tue', 'bench']]);
  assert.deepEqual(out.sessions.map((s) => [s.id, s.sets.length]), [['bench@2026-09-01', 1]]);
  assert.equal(out.weighins[0].weight, 79.2);
});

test('mergeImport adds missing records, replaces untouched defaults and is idempotent', () => {
  const now = 1000;
  const local = [{ id: 'tue', name: 'Tuesday', updatedAt: 0, createdAt: 0 }, { id: 'mine', name: 'Mine', updatedAt: 5 }];
  const imported = [{ id: 'tue', name: 'Tue (Iron Log)' }, { id: 'mine', name: 'theirs' }, { id: 'new', name: 'New' }];
  const first = mergeImport(local, imported, now);
  assert.equal(first.added, 2);
  assert.deepEqual(first.items.map((x) => x.name), ['Tue (Iron Log)', 'Mine', 'New']);
  assert.equal(mergeImport(first.items, imported, now + 1).added, 0);
});

test('combineIronLog prefers the second source per record', () => {
  const a = { programs: [{ id: 'p' }], sessions: [{ id: 's', v: 'a' }, { id: 'only-a' }], weighins: [] };
  const b = { programs: [], sessions: [{ id: 's', v: 'b' }], weighins: [{ id: 'w' }] };
  const c = combineIronLog(a, b);
  assert.deepEqual(c.programs, [{ id: 'p' }]);
  assert.deepEqual(c.sessions.map((s) => s.v || s.id), ['b', 'only-a']);
  assert.equal(c.weighins.length, 1);
});

test('progressGroups lists each current exercise once, by split day', () => {
  const programs = [
    { id: 'b', name: 'Thursday', order: 1, exercises: [{ id: 'dl', name: 'Deadlift' }, { id: 'bench', name: 'Bench' }] },
    { id: 'a', name: 'Tuesday', order: 0, exercises: [{ id: 'bench', name: 'Bench' }] },
    { id: 'c', name: 'Empty', order: 2, exercises: [] },
  ];
  const g = progressGroups(programs);
  assert.deepEqual(g.map((x) => [x.title, x.exercises.map((e) => e.id)]), [['Tuesday', ['bench']], ['Thursday', ['dl']]]);
});
