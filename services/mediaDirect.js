import { dropboxEnabled, dropboxRpc } from './dropbox.js';
import { directPlayable } from '../utils/mediaProxy.js';

// Playing a gallery video STRAIGHT from Dropbox instead of through our server.
//
// When the link belongs to the Dropbox account the CRM is connected to (Dropbox then tells us where the file is in that account), Dropbox
// gives a direct link valid for 4 hours — on its own fast servers, with the file's real type — and the player uses it: the video never
// passes through our (small) server. Anyone else's link, a .mov (see utils/mediaProxy.js directPlayable), no Dropbox connection, a
// permission the app lacks (files.content.read — run scripts/dropboxConnect.mjs again) or Dropbox not answering: no direct link, and the
// relay (services/mediaStream.js) plays it as before. Never an error to the viewer.
//
// The answer is remembered (3.5 hours for a link — Dropbox's lasts 4; 10 minutes for "no") so opening a video costs Dropbox two small
// calls the first time only. MEDIA_DIRECT=off switches it off.

const LINK_KEEP_MS = 3.5 * 3600 * 1000;
const NO_KEEP_MS = 10 * 60 * 1000;
const MAX_KEPT = 300;
const kept = new Map(); // `${url}#${path}` → { until, value }

/**
 * A direct link for the file shared by [url] (a file link; or a folder link and [path] inside it, '/Day 1/clip.mp4') named
 * [fileName] → { url, until } or null (play it through the server).
 */
export const directLinkFor = async (url, path, fileName, now = Date.now()) => {
  if (String(process.env.MEDIA_DIRECT ?? '').toLowerCase() === 'off') return null;
  if (!dropboxEnabled() || !directPlayable(fileName) || !url) return null;
  const key = `${url}#${path ?? ''}`;
  const hit = kept.get(key);
  if (hit && hit.until > now) return hit.value;

  let value = null;
  try {
    const meta = await dropboxRpc('sharing/get_shared_link_metadata', { url, ...(path ? { path } : {}) });
    // path_lower only comes when the file is in the connected account; someone else's link has none
    if (!meta.error && meta['.tag'] === 'file' && meta.path_lower) {
      const t = await dropboxRpc('files/get_temporary_link', { path: meta.path_lower });
      if (!t.error && t.link) value = { url: t.link, until: new Date(now + LINK_KEEP_MS).toISOString() };
    }
  } catch {
    value = null; // no key, a permission the app lacks, Dropbox down: the relay plays it
  }
  kept.delete(key);
  kept.set(key, { until: now + (value ? LINK_KEEP_MS : NO_KEEP_MS), value });
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
  return value;
};

export const _resetDirectLinks = () => kept.clear();
