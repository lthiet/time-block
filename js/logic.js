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

const TIME = String.raw`\d{1,2}(?:[:.h]?\d{2})?\s*(?:am|pm|a|p)?`;
const LINE_RE = new RegExp(
  String.raw`^(?:(\S+)\s+)?(${TIME})\s*(?:-|–|—|to)\s*(${TIME})\s+(.+)$`,
  'i',
);

/**
 * Parse quick-entry text, one block per line:
 *   "9:00-10:30 Deep work"
 *   "2026-09-28 14:00-15:00 Review PRs"
 *   "tomorrow 9am-10am Gym"
 * A line may also be just a date token, which sets the date for following lines.
 * Returns { rows: [{title,date,start,end}], errors: [{line, text, reason}] }.
 */
export function parseQuickText(text, defaultDate, today) {
  const rows = [];
  const errors = [];
  let date = defaultDate;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim().replace(/^[-*•]\s+/, '');
    if (!line || line.startsWith('#')) return;
    const onlyDate = resolveDate(line.replace(/:$/, ''), today);
    if (onlyDate) {
      date = onlyDate;
      return;
    }
    const m = line.match(LINE_RE);
    if (!m) {
      errors.push({ line: i + 1, text: raw, reason: 'Expected "start-end title"' });
      return;
    }
    let rowDate = date;
    if (m[1]) {
      rowDate = resolveDate(m[1], today);
      if (!rowDate) {
        errors.push({ line: i + 1, text: raw, reason: `Unknown date "${m[1]}"` });
        return;
      }
    }
    const start = parseTime(m[2]);
    const end = parseTime(m[3]);
    if (!start || !end) {
      errors.push({ line: i + 1, text: raw, reason: 'Invalid time' });
      return;
    }
    rows.push({ title: m[4].trim(), date: rowDate, start, end });
  });
  return { rows, errors };
}

/** Returns a list of problems with a row; empty if valid. */
export function validateRow(row) {
  const issues = [];
  if (!row.title || !row.title.trim()) issues.push('Missing title');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) issues.push('Missing date');
  const hhmm = /^\d{2}:\d{2}$/;
  if (!row.start) issues.push('Missing start');
  else if (!hhmm.test(row.start)) issues.push(`Can't read start time "${row.start}"`);
  if (!row.end) issues.push('Missing end');
  else if (!hhmm.test(row.end)) issues.push(`Can't read end time "${row.end}"`);
  if (!issues.length && minutesBetween(row.start, row.end) <= 0) {
    issues.push('End must be after start');
  }
  return issues;
}

export function isBlank(row) {
  return !(row.title && row.title.trim());
}

export function rowInterval(row) {
  return {
    start: new Date(`${row.date}T${row.start}:00`),
    end: new Date(`${row.date}T${row.end}:00`),
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

/**
 * Find conflicts for each valid row against existing events and other rows.
 * `rows` items must have an `id`. Invalid rows are skipped (never reported as conflicts).
 * Returns Map(rowId -> [{kind:'event', event} | {kind:'row', index, row}]).
 */
export function findConflicts(rows, events) {
  const result = new Map();
  const valid = rows
    .map((row, index) => ({ row, index, iv: validateRow(row).length ? null : rowInterval(row) }))
    .filter((r) => r.iv);
  for (const a of valid) {
    const list = [];
    for (const ev of events) {
      if (overlaps(a.iv, ev)) list.push({ kind: 'event', event: ev });
    }
    for (const b of valid) {
      if (b !== a && overlaps(a.iv, b.iv)) list.push({ kind: 'row', index: b.index, row: b.row });
    }
    list.sort((x, y) => startOf(x) - startOf(y));
    result.set(a.row.id, list);
  }
  return result;
}

function startOf(c) {
  return c.kind === 'event' ? c.event.start.getTime() : rowInterval(c.row).start.getTime();
}

/** Time range [min start, max end] across valid rows, or null. */
export function rowsRange(rows) {
  let min = null;
  let max = null;
  for (const row of rows) {
    if (validateRow(row).length) continue;
    const iv = rowInterval(row);
    if (!min || iv.start < min) min = iv.start;
    if (!max || iv.end > max) max = iv.end;
  }
  return min ? { start: min, end: max } : null;
}

/** Stable signature of the rows' checkable content (to detect edits after a check). */
export function rowsSignature(rows, extra = '') {
  return JSON.stringify([extra, rows.map((r) => [r.id, r.title.trim(), r.date, r.start, r.end])]);
}

export const APP_TAG = 'time-block-app';

export function buildEventPayload(row, timeZone) {
  return {
    summary: row.title.trim(),
    start: { dateTime: `${row.date}T${row.start}:00`, timeZone },
    end: { dateTime: `${row.date}T${row.end}:00`, timeZone },
    extendedProperties: { private: { source: APP_TAG } },
  };
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
