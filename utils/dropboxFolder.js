// A DROPBOX FOLDER LINK — what artists send for a work's footage ("Share → Copy link" on a folder:
// https://www.dropbox.com/scl/fo/<id>/<key>?rlkey=…&dl=0). Pure — tests/dropboxFolder.test.js.
//
// The link itself shows nothing inside the app: Dropbox only shows a folder's files on its own page. So:
//   • always: the folder is shown AS a folder (never as a video that will not play), it opens in Dropbox, and "Download all" gets the
//     whole folder as one .zip (the same link with dl=1);
//   • with the server's Dropbox app connected (services/dropbox.js): the server reads the folder through the link — any Dropbox account's
//     folder, as long as it is shared as "anyone with the link" — lists its videos and pictures, and plays each one in the app through the
//     media relay (services/mediaStream.js), a file at a time.

import { PLAYABLE_EXTENSIONS } from './mediaProxy.js';
import { sizeLabel } from './workFootage.js';

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'avi', 'mkv', 'mts', 'm2ts', '3gp', 'mpg', 'mpeg', 'wmv', 'hevc']);
const PICTURE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff', 'dng', 'cr2', 'cr3', 'arw', 'nef', 'raf', 'orf', 'rw2']);
/** Pictures a browser shows by itself (the others — HEIC, camera RAW — open in Dropbox). */
const SHOWABLE_PICTURE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };

export const extOf = (name) => {
  const n = String(name ?? '');
  return n.includes('.') ? n.split('.').pop().toLowerCase() : '';
};

/** 'video' | 'picture' | 'other', from the file's name. */
export const folderMediaOf = (name) => {
  const e = extOf(name);
  if (VIDEO_EXT.has(e)) return 'video';
  if (PICTURE_EXT.has(e)) return 'picture';
  return 'other';
};

/** Can the app show this file itself (through the relay)? A video a browser plays, or a picture a browser shows. */
export const showableInApp = (name) => PLAYABLE_EXTENSIONS.includes(extOf(name)) || !!SHOWABLE_PICTURE[extOf(name)];

/** The type a picture is sent with; null when it is not a picture a browser shows. */
export const pictureTypeOf = (name) => SHOWABLE_PICTURE[extOf(name)] ?? null;

/**
 * A pasted link → { url } when it is a Dropbox FOLDER link (old /sh/… or new /scl/fo/…), kept as Dropbox needs it (rlkey stays — the
 * new links do not open without it; dl and raw go); else { error }.
 */
export const dropboxFolderLink = (raw) => {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return { error: 'That is not a link.' };
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !(host === 'dropbox.com' || host === 'www.dropbox.com')) return { error: 'That is not a Dropbox folder link.' };
  if (u.username || u.password || (u.port && u.port !== '443')) return { error: 'That is not a Dropbox folder link.' };
  const segs = u.pathname.split('/').filter(Boolean);
  const folder = segs[0] === 'sh' || (segs[0] === 'scl' && segs[1] === 'fo');
  if (!folder) return { error: 'That is not a Dropbox folder link.' };
  u.hash = '';
  u.searchParams.delete('dl');
  u.searchParams.delete('raw');
  return { url: u.toString() };
};

export const isDropboxFolderLink = (raw) => !dropboxFolderLink(raw).error;

/** The same folder as one .zip download (Dropbox's own "Download" on a shared folder). */
export const folderZipUrl = (raw) => {
  const f = dropboxFolderLink(raw);
  if (f.error) return '';
  const u = new URL(f.url);
  u.searchParams.set('dl', '1');
  return u.toString();
};

/** The folder's Dropbox page opened on one of its files ([name] at the top of the folder). */
export const folderPreviewUrl = (raw, name) => {
  const f = dropboxFolderLink(raw);
  if (f.error) return '';
  const u = new URL(f.url);
  if (name) u.searchParams.set('preview', String(name));
  return u.toString();
};

/**
 * A place inside the shared folder: '' (the top) or '/Day 1/clip.mp4'. → the path, or null when it could climb out of the folder or is
 * not a plain path.
 */
export const innerPath = (raw, { allowRoot = true } = {}) => {
  const p = String(raw ?? '');
  if (p === '' || p === '/') return allowRoot ? '' : null;
  if (!p.startsWith('/') || p.length > 1000 || p.includes('\\') || /[\u0000-\u001f]/.test(p)) return null;
  const segs = p.split('/').slice(1);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return p;
};

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Dropbox's listing of a folder (through a shared link) → what the app shows: its sub-folders, its files (videos and pictures first is
 * NOT done — files keep their names' order, the order the camera wrote them: C0001, C0002 … C0010), and the counts. [base] is where
 * this listing is inside the shared folder ('' for the top).
 */
export const folderListing = (entries, base = '') => {
  const folders = [];
  const files = [];
  for (const e of entries ?? []) {
    const tag = e?.['.tag'] ?? e?.tag;
    const name = String(e?.name ?? '');
    if (!name) continue;
    const path = `${base}/${name}`;
    if (tag === 'folder') folders.push({ name, path });
    else if (tag === 'file') {
      const media = folderMediaOf(name);
      files.push({ name, path, size: Number(e.size) || 0, modifiedAt: e.client_modified ?? e.server_modified ?? null, media, showable: showableInApp(name) });
    }
  }
  folders.sort(byName);
  files.sort(byName);
  const totalBytes = files.reduce((t, f) => t + f.size, 0);
  const videoCount = files.filter((f) => f.media === 'video').length;
  const pictureCount = files.filter((f) => f.media === 'picture').length;
  return { folders, files, totalBytes, videoCount, pictureCount, summary: folderSummary({ videoCount, pictureCount, otherCount: files.length - videoCount - pictureCount, folderCount: folders.length, totalBytes }) };
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 videos · 3 pictures · 4.2 GB" — "Empty folder" when there is nothing; sub-folders are named when there are some. */
export const folderSummary = ({ videoCount = 0, pictureCount = 0, otherCount = 0, folderCount = 0, totalBytes = 0 }) => {
  const parts = [];
  if (videoCount) parts.push(plural(videoCount, 'video'));
  if (pictureCount) parts.push(plural(pictureCount, 'picture'));
  if (otherCount) parts.push(plural(otherCount, 'other file'));
  if (folderCount) parts.push(plural(folderCount, 'folder'));
  if (!parts.length) return 'Empty folder';
  const size = sizeLabel(totalBytes);
  return size ? [...parts, size].join(' · ') : parts.join(' · ');
};

/** Kinds of trouble with an artist's folder link, in words the artist can act on. */
export const FOLDER_PROBLEMS = {
  private: 'Dropbox says this folder is not open to anyone with the link. In Dropbox: Share → set "Anyone with this link can view" → Copy link, and add that link.',
  missing: 'Dropbox says this folder link does not work any more — the folder was moved or deleted, or the link was switched off. Copy a new link in Dropbox.',
  password: 'This folder link needs a password. Share it without a password ("Anyone with this link can view").',
  expired: 'This folder link has expired. Copy a new link in Dropbox.',
  not_folder: 'That link is a file, not a folder.',
  other: 'Dropbox could not open the folder.',
};

/** Dropbox's error for a shared-link listing → { code, message }. */
export const folderProblemOf = (errorSummary = '') => {
  const s = String(errorSummary ?? '').toLowerCase();
  const p = (code) => ({ code, message: FOLDER_PROBLEMS[code] });
  if (/password/.test(s)) return p('password');
  if (/expired/.test(s)) return p('expired');
  if (/access_denied|email_unverified|no_permission|team_only|forbidden/.test(s)) return p('private');
  if (/not_found|malformed|link_not_found|deleted/.test(s)) return p('missing');
  if (/not_folder|is_file|unsupported_link_type/.test(s)) return p('not_folder');
  return { code: 'other', message: `${FOLDER_PROBLEMS.other}${s ? ` (${String(errorSummary).replace(/\/+\.*$/, '')})` : ''}` };
};
