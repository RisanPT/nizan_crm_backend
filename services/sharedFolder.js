import { folderListing, folderProblemOf } from '../utils/dropboxFolder.js';
import { listSharedFolder } from './dropbox.js';

// What is inside a Dropbox folder shared by link (an artist's footage folder), read through the server's Dropbox app and remembered a
// few minutes — opening one clip after another does not list the folder again. Used by the gallery's folder view
// (controllers/marketingMediaController.js) and when an artist hands in a folder link (controllers/workFootageController.js).

const LISTING_TTL_MS = 5 * 60 * 1000;
const listings = new Map(); // `${url}#${path}` → { at, value }
export const _resetFolderListings = () => listings.clear();

/**
 * → { ok: true, files, folders, totalBytes, videoCount, pictureCount, summary } or { ok: false, code, message } (the link's trouble, in
 * words the artist can act on). The server's own trouble (no key, Dropbox down, too slow) is a DropboxProblem — thrown.
 */
export const readSharedFolder = async (url, path = '', { fresh = false, now = Date.now() } = {}) => {
  const key = `${url}#${path}`;
  const hit = listings.get(key);
  if (!fresh && hit && now - hit.at < LISTING_TTL_MS) return hit.value;
  const r = await listSharedFolder(url, path);
  const value = r.error_summary ? { ok: false, ...folderProblemOf(r.error_summary) } : { ok: true, ...folderListing(r.entries, path) };
  // a refusal is kept only a minute (the artist may fix the sharing straight away)
  listings.set(key, { at: value.ok ? now : now - LISTING_TTL_MS + 60_000, value });
  if (listings.size > 300) listings.delete(listings.keys().next().value);
  return value;
};
