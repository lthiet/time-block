// Google Identity Services token client wrapper (browser-only OAuth, no backend).

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
// Optional: lets the task board sync between devices. Sign-in still works without it.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPES = [...CALENDAR_SCOPES, DRIVE_SCOPE].join(' ');

const STORE_KEY = 'tb.token';
const HINT_KEY = 'tb.loginHint';

let tokenClient = null;
let token = null;
let expiresAt = 0;
let granted = '';

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const started = Date.now();
    const iv = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - started > 15000) {
        clearInterval(iv);
        reject(new Error('Could not load Google sign-in. Check your connection or content blockers.'));
      }
    }, 50);
  });
}

export async function initAuth(clientId) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
    // Tokens saved before Drive sync existed carry no scope list; drop them so sign-in asks again.
    if (saved && saved.expiresAt > Date.now() + 60_000 && typeof saved.scope === 'string') {
      token = saved.token;
      expiresAt = saved.expiresAt;
      granted = saved.scope;
    }
  } catch { /* storage unavailable */ }
  await loadGis();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: () => {},
  });
}

export function isSignedIn() {
  return !!token && expiresAt > Date.now() + 60_000;
}

/** Whether the current token includes `scope`. */
export function hasScope(scope) {
  return isSignedIn() && granted.split(' ').includes(scope);
}

export function setLoginHint(email) {
  try { localStorage.setItem(HINT_KEY, email); } catch { /* ignore */ }
}

function request(prompt) {
  if (!tokenClient) return Promise.reject(new Error('Google sign-in is not ready. Check the Client ID in config.js.'));
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, ...CALENDAR_SCOPES)) {
        return reject(new Error('Calendar access was not granted. Please allow both calendar permissions.'));
      }
      token = resp.access_token;
      expiresAt = Date.now() + Number(resp.expires_in || 3600) * 1000;
      granted = resp.scope || '';
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ token, expiresAt, scope: granted })); } catch { /* ignore */ }
      resolve(token);
    };
    tokenClient.error_callback = (err) => {
      reject(new Error(err?.type === 'popup_closed' ? 'Sign-in window was closed.' : (err?.message || 'Sign-in failed.')));
    };
    let hint = '';
    try { hint = localStorage.getItem(HINT_KEY) || ''; } catch { /* ignore */ }
    tokenClient.requestAccessToken({ prompt, login_hint: hint || undefined });
  });
}

/** Interactive sign-in (call from a click handler). */
export function signIn() {
  return request(token ? '' : 'select_account');
}

/** Ask again for permissions that were left unticked (call from a click handler). */
export function grantMissing() {
  return request('consent');
}

/**
 * Returns a valid access token, silently refreshing if needed.
 * Call synchronously at the start of a user-gesture handler so the popup isn't blocked.
 */
export function getToken() {
  if (isSignedIn()) return Promise.resolve(token);
  return request('');
}

export function invalidateToken() {
  token = null;
  expiresAt = 0;
  granted = '';
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

export function signOut() {
  if (token) window.google?.accounts?.oauth2?.revoke(token, () => {});
  invalidateToken();
  try { localStorage.removeItem(HINT_KEY); } catch { /* ignore */ }
}
