// Stores the task board as a JSON file in the app's hidden Google Drive folder (appDataFolder).
// Only this app can see that folder; it doesn't show up in the user's Drive.
import { getToken, invalidateToken } from './auth.js';
import { AuthError } from './gcal.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_NAME = 'tasks.json';

export class ScopeError extends Error {}

async function call(url, { method = 'GET', headers = {}, body, raw = false } = {}) {
  const token = await getToken();
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  if (res.status === 401) {
    invalidateToken();
    throw new AuthError('Session expired — sign in again.');
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const msg = data?.error?.message || `Google Drive error ${res.status}`;
    if (res.status === 403 && /scope|permission/i.test(msg)) throw new ScopeError(msg);
    throw new Error(msg);
  }
  return raw ? res.text() : res.json();
}

/** All copies of the task file (normally one; two devices can race to create it), oldest first. */
async function listFiles() {
  const url = new URL(`${API}/files`);
  url.searchParams.set('spaces', 'appDataFolder');
  url.searchParams.set('q', `name = '${FILE_NAME}' and trashed = false`);
  url.searchParams.set('fields', 'files(id)');
  url.searchParams.set('orderBy', 'createdTime');
  return (await call(url)).files || [];
}

/** Returns [{id, doc}] for each stored copy; `doc` is null if the file can't be parsed. */
export async function readTaskFiles() {
  const files = await listFiles();
  return Promise.all(files.map(async (f) => {
    const text = await call(`${API}/files/${encodeURIComponent(f.id)}?alt=media`, { raw: true });
    let doc = null;
    try { doc = JSON.parse(text); } catch { /* corrupt; it gets overwritten */ }
    return { id: f.id, doc };
  }));
}

/** Writes the board to file `id`, or creates the file when `id` is null. Returns the file id. */
export async function writeTaskFile(id, doc) {
  const json = JSON.stringify(doc);
  if (id) {
    await call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json,
    });
    return id;
  }
  const boundary = `tb${Math.random().toString(36).slice(2)}`;
  const body = [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
    JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] }),
    `--${boundary}`, 'Content-Type: application/json', '', json, `--${boundary}--`, '',
  ].join('\r\n');
  const created = await call(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
  return created.id;
}

export function deleteTaskFile(id) {
  return call(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
