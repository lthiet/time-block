// Pure, DOM-free helpers: parsing, validation, conflict detection, payloads.
// All dates are 'YYYY-MM-DD' strings and times 'HH:MM' strings in local time.

const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function hm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function addMinutes(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function minutesBetween(a, b) {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Resolve a date token relative to `today` ('YYYY-MM-DD').
 * Accepts YYYY-MM-DD, today, tomorrow/tmr, +N, and weekday names (next occurrence, today counts).
 * Returns 'YYYY-MM-DD' or null.
 */
export function resolveDate(token, today) {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(`${t}T00:00:00`);
    return Number.isNaN(d.getTime()) || ymd(d) !== t ? null : t;
  }
  if (t === 'today') return today;
  if (t === 'tomorrow' || t === 'tmr' || t === 'tom') return addDays(today, 1);
  const plus = t.match(/^\+(\d{1,3})$/);
  if (plus) return addDays(today, Number(plus[1]));
  const wd = WEEKDAYS.findIndex((w) => t === w || t === w.slice(0, 3));
  if (wd >= 0) {
    const cur = new Date(`${today}T00:00:00`).getDay();
    return addDays(today, (wd - cur + 7) % 7);
  }
  return null;
}

/**
 * Parse a loose time like "9", "930", "9:30", "09.30", "9am", "9:30pm", "21:15".
 * Returns 'HH:MM' or null.
 */
export function parseTime(str) {
  if (!str) return null;
  const s = str.trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3];
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm.startsWith('p') && h !== 12) h += 12;
    if (ampm.startsWith('a') && h === 12) h = 0;
  }
  if (h > 23) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** Returns a list of problems with a row; empty if valid. */
export function validateRow(row) {
  const issues = [];
  if (!row.title || !row.title.trim()) issues.push('Missing title');
  if (!DATE_RE.test(row.date || '')) issues.push('Missing date');
  const hhmm = /^\d{2}:\d{2}$/;
  if (!row.start) issues.push('Missing start');
  else if (!hhmm.test(row.start)) issues.push(`Can't read start time "${row.start}"`);
  if (!row.end) issues.push('Missing end');
  else if (!hhmm.test(row.end)) issues.push(`Can't read end time "${row.end}"`);
  if (!issues.length && minutesBetween(row.start, row.end) <= 0) {
    issues.push('End must be after start');
  }
  if (isRecurring(row) && DATE_RE.test(row.date || '')) {
    const { freq, days, until } = row.repeat;
    if (freq === 'weekly' && !days?.length) issues.push('Pick at least one day');
    else if (until && !DATE_RE.test(until)) issues.push('Invalid repeat end date');
    else if (until && until < row.date) issues.push('Repeat end is before start');
    else if (!occurrenceDates(row).length) issues.push('No matching days before the end date');
  }
  return issues;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isBlank(row) {
  return !(row.title && row.title.trim());
}

// ---------------------------------------------------------------- recurrence

/** How far ahead an open-ended repeat is conflict-checked. */
export const REPEAT_HORIZON_DAYS = 28;
const MAX_OCCURRENCES = 400;
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

export const noRepeat = () => ({ freq: '', days: [], until: '' });

export function isRecurring(row) {
  return !!row.repeat?.freq;
}

export const weekdayOf = (date) => new Date(`${date}T00:00:00`).getDay();

/** Weekday numbers (0 = Sunday) a repeat rule fires on. */
export function repeatDays(repeat) {
  switch (repeat?.freq) {
    case 'daily': return [0, 1, 2, 3, 4, 5, 6];
    case 'weekdays': return [1, 2, 3, 4, 5];
    case 'weekly': return [...new Set(repeat.days || [])].sort();
    default: return [];
  }
}

/** Last date that gets conflict-checked for a row. */
export function checkUntil(row) {
  if (!isRecurring(row)) return row.date;
  return row.repeat.until || addDays(row.date, REPEAT_HORIZON_DAYS - 1);
}

/** Dates (YYYY-MM-DD) of every occurrence to check: just [date] for one-off rows. */
export function occurrenceDates(row) {
  if (!isRecurring(row)) return [row.date];
  const days = new Set(repeatDays(row.repeat));
  const last = checkUntil(row);
  const out = [];
  let dow = weekdayOf(row.date);
  for (let d = row.date; d <= last && out.length < MAX_OCCURRENCES; d = addDays(d, 1)) {
    if (days.has(dow)) out.push(d);
    dow = (dow + 1) % 7;
  }
  return out;
}

/** Whether the row (one-off or series, ignoring the check horizon) has an occurrence on `date`. */
export function occursOn(row, date) {
  if (!isRecurring(row)) return row.date === date;
  if (date < row.date || (row.repeat.until && date > row.repeat.until)) return false;
  return repeatDays(row.repeat).includes(weekdayOf(date));
}

/** First date on/after row.date that matches the rule (the series start). */
export function firstOccurrence(row) {
  if (!isRecurring(row)) return row.date;
  const days = new Set(repeatDays(row.repeat));
  let d = row.date;
  for (let i = 0; i < 7 && !days.has(weekdayOf(d)); i++) d = addDays(d, 1);
  return d;
}

export function buildRRule(repeat) {
  const parts = [];
  if (repeat.freq === 'daily') parts.push('FREQ=DAILY');
  else {
    const days = new Set(repeatDays(repeat));
    parts.push('FREQ=WEEKLY', `BYDAY=${MONDAY_FIRST.filter((d) => days.has(d)).map((d) => DAY_CODES[d]).join(',')}`);
  }
  if (repeat.until) {
    // UNTIL must be UTC for timed events; use the end of the local day.
    const utc = new Date(`${repeat.until}T23:59:59`).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    parts.push(`UNTIL=${utc}`);
  }
  return `RRULE:${parts.join(';')}`;
}

/** Short label like "Every weekday" or "Weekly on Mon, Wed" (without the end date). */
export function describeRepeat(repeat) {
  switch (repeat?.freq) {
    case 'daily': return 'Daily';
    case 'weekdays': return 'Every weekday';
    case 'weekly': {
      const days = new Set(repeatDays(repeat));
      return `Weekly on ${MONDAY_FIRST.filter((d) => days.has(d)).map((d) => DAY_SHORT[d]).join(', ')}`;
    }
    default: return '';
  }
}

// ---------------------------------------------------------------- conflicts

export function rowInterval(row, date = row.date) {
  return {
    start: new Date(`${date}T${row.start}:00`),
    end: new Date(`${date}T${row.end}:00`),
  };
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Convert a Calendar API event into {id,title,start,end,allDay,calendarId,calendarName,color}
 * or null when it should not block time.
 */
export function normalizeEvent(ev, cal, { includeAllDay = false } = {}) {
  if (!ev || ev.status === 'cancelled') return null;
  if (ev.transparency === 'transparent') return null;
  const self = (ev.attendees || []).find((a) => a.self);
  if (self && self.responseStatus === 'declined') return null;
  const allDay = !ev.start?.dateTime;
  if (allDay && !includeAllDay) return null;
  const start = allDay ? new Date(`${ev.start.date}T00:00:00`) : new Date(ev.start.dateTime);
  const end = allDay ? new Date(`${ev.end.date}T00:00:00`) : new Date(ev.end.dateTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    id: ev.id,
    title: ev.summary || '(busy)',
    start,
    end,
    allDay,
    link: ev.htmlLink,
    calendarId: cal.id,
    calendarName: cal.name,
    color: cal.color,
  };
}

function occurrenceIntervals(row) {
  return occurrenceDates(row).map((date) => ({ date, ...rowInterval(row, date) }));
}

/**
 * Find conflicts for each valid row (every checked occurrence, for repeating rows) against
 * existing events and other rows. `rows` items must have an `id`. Invalid rows are skipped.
 * Returns Map(rowId -> [{kind:'event', event, occDate, start} | {kind:'row', index, row, occDate, start}]).
 */
export function findConflicts(rows, events) {
  const result = new Map();
  const valid = rows
    .map((row, index) => ({ row, index, ivs: validateRow(row).length ? null : occurrenceIntervals(row) }))
    .filter((r) => r.ivs);
  for (const a of valid) {
    const list = [];
    for (const iv of a.ivs) {
      for (const ev of events) {
        if (overlaps(iv, ev)) list.push({ kind: 'event', event: ev, occDate: iv.date, start: ev.start });
      }
      for (const b of valid) {
        if (b === a) continue;
        const hit = b.ivs.find((biv) => overlaps(iv, biv));
        if (hit) list.push({ kind: 'row', index: b.index, row: b.row, occDate: iv.date, start: hit.start });
      }
    }
    list.sort((x, y) => x.start - y.start);
    result.set(a.row.id, list);
  }
  return result;
}

/** Time range [min start, max end] across all checked occurrences of valid rows, or null. */
export function rowsRange(rows) {
  let min = null;
  let max = null;
  for (const row of rows) {
    if (validateRow(row).length) continue;
    const dates = occurrenceDates(row);
    const first = rowInterval(row, dates[0]);
    const last = rowInterval(row, dates[dates.length - 1]);
    if (!min || first.start < min) min = first.start;
    if (!max || last.end > max) max = last.end;
  }
  return min ? { start: min, end: max } : null;
}

/** Stable signature of the rows' checkable content (to detect edits after a check). */
export function rowsSignature(rows, extra = '') {
  return JSON.stringify([extra, rows.map((r) => [
    r.id, r.title.trim(), r.date, r.start, r.end, isRecurring(r) ? r.repeat : null,
  ])]);
}

export const APP_TAG = 'time-block-app';

export function buildEventPayload(row, timeZone) {
  const date = firstOccurrence(row);
  const payload = {
    summary: row.title.trim(),
    start: { dateTime: `${date}T${row.start}:00`, timeZone },
    end: { dateTime: `${date}T${row.end}:00`, timeZone },
    extendedProperties: { private: { source: APP_TAG } },
  };
  if (isRecurring(row)) payload.recurrence = [buildRRule(row.repeat)];
  return payload;
}

/**
 * Assign side-by-side lanes to overlapping items (for the agenda timeline).
 * Items need numeric `s` and `e` (minutes). Mutates items with `lane` and `lanes`.
 */
export function assignLanes(items) {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const n = Math.max(0, ...cluster.map((i) => i.lane + 1));
    cluster.forEach((i) => { i.lanes = n; });
    cluster = [];
  };
  for (const it of sorted) {
    if (it.s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.e > it.s).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    it.lane = lane;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return items;
}

// ---------------------------------------------------------------- tasks

export const TASK_STATUSES = ['backlog', 'waiting', 'doing', 'done'];

/** Compact age like "5m", "3h", "2d", "3w" for how long something has been waiting. */
export function waitingAge(sinceMs, nowMs) {
  const mins = Math.max(0, Math.floor((nowMs - sinceMs) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/**
 * Move task `id` to `status` at position `index` among that lane's other tasks.
 * Returns a new array; stamps waitingSince / doneAt when the status changes.
 */
export function moveTask(tasks, id, status, index, now) {
  const task = tasks.find((t) => t.id === id);
  if (!task || !TASK_STATUSES.includes(status)) return tasks;
  const moved = { ...task, status };
  if (status !== task.status) {
    moved.waitingSince = status === 'waiting' ? now : null;
    moved.doneAt = status === 'done' ? now : null;
  }
  const rest = tasks.filter((t) => t.id !== id);
  const lane = rest.filter((t) => t.status === status);
  const i = Math.max(0, Math.min(index, lane.length));
  let at;
  if (i < lane.length) at = rest.indexOf(lane[i]);
  else if (lane.length) at = rest.indexOf(lane[lane.length - 1]) + 1;
  else at = rest.length;
  rest.splice(at, 0, moved);
  return rest;
}

// ---------------------------------------------------------------- task sync

/** How long a deleted task is remembered so another device's copy doesn't bring it back. */
export const TASK_TOMBSTONE_TTL = 90 * 86_400_000;

const taskStamp = (t) => t.updatedAt || t.createdAt || 0;
const taskBody = ({ updatedAt, ...rest }) => JSON.stringify(rest);

/**
 * Compare the board before and after a local edit. Returns the tasks with `updatedAt`
 * bumped on the ones that changed, the ids that were removed, and whether the order changed.
 */
export function stampTaskChanges(prev, tasks, now) {
  const before = new Map(prev.map((t) => [t.id, taskBody(t)]));
  const ids = new Set(tasks.map((t) => t.id));
  const stamped = tasks.map((t) => (before.get(t.id) === taskBody(t) ? t : { ...t, updatedAt: now }));
  const removed = prev.filter((t) => !ids.has(t.id)).map((t) => t.id);
  const reordered = prev.map((t) => t.id).filter((id) => ids.has(id)).join() !== tasks.map((t) => t.id).filter((id) => before.has(id)).join();
  return { tasks: stamped, removed, reordered };
}

/**
 * Merge two task boards `{tasks, deleted: {id: ms}, orderedAt}`. Per task the newer edit wins and
 * a deletion wins over older edits. Order follows the board that was rearranged last; tasks only the
 * other board has are added at the end. Unchanged task objects from `a` are kept as-is.
 */
export function mergeTaskDocs(a, b, now) {
  const empty = { tasks: [], deleted: {}, orderedAt: 0 };
  a = { ...empty, ...a };
  b = { ...empty, ...b };
  const deleted = {};
  for (const src of [a.deleted, b.deleted]) {
    for (const [id, at] of Object.entries(src || {})) {
      if (now - at < TASK_TOMBSTONE_TTL && !(deleted[id] >= at)) deleted[id] = at;
    }
  }
  const pick = new Map();
  for (const t of a.tasks) pick.set(t.id, t);
  for (const t of b.tasks) {
    const mine = pick.get(t.id);
    if (!mine || taskStamp(t) > taskStamp(mine)) pick.set(t.id, t);
  }
  const [first, second] = (b.orderedAt || 0) > (a.orderedAt || 0) ? [b, a] : [a, b];
  const order = [...new Set([...first.tasks, ...second.tasks].map((t) => t.id))];
  const tasks = order.map((id) => pick.get(id)).filter((t) => !(deleted[t.id] >= taskStamp(t)));
  return { tasks, deleted, orderedAt: Math.max(a.orderedAt || 0, b.orderedAt || 0) };
}
