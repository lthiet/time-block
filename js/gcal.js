// Minimal Google Calendar API v3 client using fetch.
import { getToken, invalidateToken } from './auth.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

export class AuthError extends Error {}

async function api(path, { method = 'GET', params, body } = {}) {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const token = await getToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    invalidateToken();
    throw new AuthError('Session expired — sign in again.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Google Calendar error ${res.status}`);
  }
  return data;
}

/** Returns [{id, name, color, primary, accessRole}] for calendars in the user's list. */
export async function listCalendars() {
  const out = [];
  let pageToken;
  do {
    const data = await api('/users/me/calendarList', {
      params: { pageToken, maxResults: 250, showHidden: true },
    });
    for (const c of data.items || []) {
      out.push({
        id: c.id,
        name: c.summaryOverride || c.summary,
        color: c.backgroundColor,
        primary: !!c.primary,
        accessRole: c.accessRole,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/** All (expanded) events on a calendar overlapping [timeMin, timeMax). */
export async function listEvents(calendarId, timeMin, timeMax) {
  const out = [];
  let pageToken;
  do {
    const data = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      params: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500,
        pageToken,
      },
    });
    out.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

export function insertEvent(calendarId, payload) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: payload });
}

export function deleteEvent(calendarId, eventId) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
}

/** Run async fn over items with limited concurrency, returning settled results in order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
