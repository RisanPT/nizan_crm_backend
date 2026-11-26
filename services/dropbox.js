// The company's Dropbox, for footage from works (controllers/workFootageController.js). OFF until the server has a Dropbox app:
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN (a long-lived refresh token for the company account), or — for a quick
//   trial — DROPBOX_ACCESS_TOKEN alone. DROPBOX_ROOT is where works' folders go ("/Team N Works" when not set).
//   The app needs the scopes files.metadata.read, files.content.read, files.content.write, file_requests.write, sharing.write and sharing.read.
//
// With it on, an artist taps "Upload to Dropbox" on their work and gets a Dropbox FILE REQUEST for that work's folder — a page that takes
// files from a phone without a Dropbox login; the videos land in "/Team N Works/2026-11/2026-11-18 · BK-1234 · Amina K · Bridal".
// "Check the upload" lists that folder and shares it, so Marketing gets the link (and the size) without anyone typing it.
// With it off, the artist uploads to Dropbox themselves and pastes the link: the same record, the same screens.
//
// FOLDER LINKS FROM ANYONE: an artist's own shared folder ("anyone with the link") can be read through its link — the files listed
// ([listSharedFolder]) and each fetched in pieces for the player ([fetchSharedLinkFile]) — which needs the scope sharing.read too.
//
// [_setDropboxFetch] swaps the HTTP call (tests use a local stand-in Dropbox). DROPBOX_API_URL / DROPBOX_CONTENT_URL / DROPBOX_TOKEN_URL
// point elsewhere for the same reason; nothing else should set them.

let fetchImpl = (...a) => fetch(...a);
export const _setDropboxFetch = (fn) => {
  fetchImpl = fn ?? ((...a) => fetch(...a));
  token = null;
};

const env = (k) => String(process.env[k] ?? '').trim();
const apiBase = () => env('DROPBOX_API_URL') || 'https://api.dropboxapi.com';
const contentBase = () => env('DROPBOX_CONTENT_URL') || 'https://content.dropboxapi.com';
const tokenUrl = () => env('DROPBOX_TOKEN_URL') || 'https://api.dropbox.com/oauth2/token';

export const dropboxRoot = () => env('DROPBOX_ROOT') || '/Team N Works';

/** Is Dropbox connected on this server? */
export const dropboxEnabled = () => !!env('DROPBOX_ACCESS_TOKEN') || (!!env('DROPBOX_APP_KEY') && !!env('DROPBOX_APP_SECRET') && !!env('DROPBOX_REFRESH_TOKEN'));

export class DropboxProblem extends Error {
  constructor(message, { status = 502, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let token = null; // { value, until }

const accessToken = async () => {
  if (env('DROPBOX_ACCESS_TOKEN')) return env('DROPBOX_ACCESS_TOKEN');
  if (token && token.until > Date.now() + 60 * 1000) return token.value;
  let res;
  try {
    res = await fetchImpl(tokenUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env('DROPBOX_REFRESH_TOKEN'), client_id: env('DROPBOX_APP_KEY'), client_secret: env('DROPBOX_APP_SECRET') }).toString(),
    });
  } catch {
    throw new DropboxProblem('Dropbox could not be reached just now. Try again in a minute, or paste the link instead.', { code: 'network' });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new DropboxProblem('Dropbox refused the CRM\'s key (DROPBOX_REFRESH_TOKEN). Ask IT to reconnect Dropbox — meanwhile paste the link instead.', { code: 'auth' });
  token = { value: body.access_token, until: Date.now() + (Number(body.expires_in) || 14400) * 1000 };
  return token.value;
};

/** The permission Dropbox says the app lacks ("missing_scope", 401) — '' when that is not the trouble. */
export const missingScopeOf = (json) => {
  if (!/missing_scope/.test(String(json?.error_summary ?? json?.error?.['.tag'] ?? ''))) return '';
  return String(json?.error?.required_scope ?? 'a permission');
};
export const missingScopeMessage = (scope) =>
  `The CRM's Dropbox app has not been given the permission "${scope}". In the Dropbox App Console → the app → Permissions, tick files.metadata.read, files.content.read, files.content.write, file_requests.write, sharing.read and sharing.write, click Submit — then run "node scripts/dropboxConnect.mjs" again (the Dropbox account clicks Allow once more).`;

/** One Dropbox API call. A Dropbox "error" answer (409) comes back as { error } for the caller to read; anything else wrong throws. */
export const dropboxRpc = async (endpoint, body) => {
  const t = await accessToken();
  let res;
  try {
    res = await fetchImpl(`${apiBase()}/2/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? null) });
  } catch {
    throw new DropboxProblem('Dropbox could not be reached just now. Try again in a minute, or paste the link instead.', { code: 'network' });
  }
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error_summary: text };
  }
  if (res.ok) return json;
  if (res.status === 409) return { error: json.error ?? {}, error_summary: json.error_summary ?? '' };
  if (res.status === 401) {
    // a permission the app was not given is a 401 too — said as what it is, not as a bad key
    const scope = missingScopeOf(json);
    if (scope) throw new DropboxProblem(missingScopeMessage(scope), { code: 'scope' });
    token = null;
    throw new DropboxProblem('Dropbox refused the CRM\'s key. Ask IT to reconnect Dropbox — meanwhile paste the link instead.', { code: 'auth' });
  }
  if (res.status === 429) throw new DropboxProblem('Dropbox asks to slow down. Try again in a minute.', { status: 429, code: 'rate' });
  throw new DropboxProblem(`Dropbox answered with an error (HTTP ${res.status}). Try again, or paste the link instead.`, { code: 'http' });
};

/** The folder exists after this (made when it did not). */
export const ensureFolder = async (path) => {
  const r = await dropboxRpc('files/create_folder_v2', { path, autorename: false });
  if (r.error && !/path\/conflict/.test(r.error_summary ?? '')) throw new DropboxProblem(`Dropbox could not make the folder (${r.error_summary || 'unknown'}).`, { code: 'folder' });
  return path;
};

/** A file request into [path]: a page that takes files without a Dropbox login → { id, url }. */
export const createFileRequest = async (path, title) => {
  const r = await dropboxRpc('file_requests/create', { title: String(title).slice(0, 140), destination: path, open: true });
  if (r.error || !r.url) throw new DropboxProblem(`Dropbox could not make the upload page (${r.error_summary || 'no link'}).`, { code: 'request' });
  return { id: r.id, url: r.url };
};

/** What is in [path] (one level, every page) — [] when the folder does not exist yet. */
export const listFolder = async (path) => {
  let r = await dropboxRpc('files/list_folder', { path, recursive: false, limit: 500 });
  if (r.error) {
    if (/not_found/.test(r.error_summary ?? '')) return [];
    throw new DropboxProblem(`Dropbox could not list the folder (${r.error_summary}).`, { code: 'list' });
  }
  const entries = [...(r.entries ?? [])];
  for (let i = 0; r.has_more && i < 20; i += 1) {
    r = await dropboxRpc('files/list_folder/continue', { cursor: r.cursor });
    if (r.error) break;
    entries.push(...(r.entries ?? []));
  }
  return entries;
};

/** A link to [path] that the team can open (made once; an existing one is reused). */
export const sharedLinkFor = async (path) => {
  const r = await dropboxRpc('sharing/create_shared_link_with_settings', { path });
  if (!r.error && r.url) return r.url;
  const existing = r.error?.shared_link_already_exists?.metadata?.url;
  if (existing) return existing;
  const list = await dropboxRpc('sharing/list_shared_links', { path, direct_only: true });
  const url = list.links?.[0]?.url;
  if (!url) throw new DropboxProblem(`Dropbox could not share the folder (${r.error_summary || 'no link'}).`, { code: 'share' });
  return url;
};

// ── a folder shared by link (anyone's) ───────────────────────────────────────

const LIST_PAGES = 10;
const LIST_TIMEOUT_MS = 15_000;

/**
 * What is in the shared folder [url] at [path] ('' = its top; one level) → Dropbox's entries. A link Dropbox will not open comes back as
 * { error_summary } (the caller says why — utils/dropboxFolder.js folderProblemOf); the server's own trouble (no key, Dropbox down) throws.
 */
export const listSharedFolder = async (url, path = '') => {
  const call = async () => {
    let r = await dropboxRpc('files/list_folder', { path, shared_link: { url } });
    if (r.error) return { error_summary: r.error_summary || 'unknown' };
    const entries = [...(r.entries ?? [])];
    for (let i = 0; r.has_more && i < LIST_PAGES; i += 1) {
      r = await dropboxRpc('files/list_folder/continue', { cursor: r.cursor });
      if (r.error) break;
      entries.push(...(r.entries ?? []));
    }
    return { entries };
  };
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DropboxProblem('Dropbox took too long to list the folder. Try again in a minute.', { code: 'timeout' })), LIST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call(), late]);
  } finally {
    clearTimeout(timer);
  }
};

/** JSON as an HTTP header value: Dropbox wants every character past ASCII written as \uXXXX (a file named "Reveal · ദിയ.mp4"). */
export const headerJson = (obj) => JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * One file inside the shared folder [url] ([path] = '/Day 1/clip.mp4'), as Dropbox's raw answer — [range] passed on so a player can ask
 * for pieces. → { res } or { problem: { code, status } } (no key, Dropbox not reachable).
 */
export const fetchSharedLinkFile = async (url, path, { range = null, signal = null } = {}) => {
  let t;
  try {
    t = await accessToken();
  } catch (e) {
    return { problem: { code: e.code === 'network' ? 'unreachable' : 'not_connected', status: 502 } };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000); // Dropbox gets 20 s to start answering; the file then takes as long as it takes
  const stop = () => ac.abort();
  if (signal?.aborted) ac.abort();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const res = await fetchImpl(`${contentBase()}/2/sharing/get_shared_link_file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'dropbox-api-arg': headerJson({ url, path }), ...(range ? { range } : {}) },
      signal: ac.signal,
    });
    if (res.status === 401) token = null;
    return { res };
  } catch {
    signal?.removeEventListener('abort', stop);
    return { problem: { code: 'unreachable', status: 502 } };
  } finally {
    clearTimeout(timer);
  }
};
