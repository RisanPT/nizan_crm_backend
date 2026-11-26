import path from 'node:path';
import { dropboxFileUrl, signMediaToken, verifyMediaToken } from '../utils/mediaProxy.js';
import { dropboxFolderLink, folderZipUrl, innerPath, showableInApp } from '../utils/dropboxFolder.js';
import { probeDropbox, streamDropboxFile } from '../services/mediaStream.js';
import { dropboxEnabled } from '../services/dropbox.js';
import { directLinkFor } from '../services/mediaDirect.js';
import { readSharedFolder } from '../services/sharedFolder.js';

// /api/marketing/media — playing the gallery's Dropbox videos through our own server (utils/mediaProxy.js, services/mediaStream.js).
//   GET /link?url=<the Dropbox link>&probe=1   (logged in, the Marketing team — whoever opens the gallery) → a signed stream token, and
//       with probe=1 whether Dropbox will send the file (else why not, in plain words). When the file is in the Dropbox the CRM is
//       connected to, also `direct: { url, until }` — a 4-hour link the player uses first, so the video never passes through our server
//       (services/mediaDirect.js); the token stays as the fallback.
//       With &path=/clip.mp4 and a FOLDER link: the file inside that folder (needs the server's Dropbox app — services/dropbox.js).
//   GET /folder?url=<a Dropbox folder link>&path=  what is inside the folder (utils/dropboxFolder.js) — or, with no Dropbox app on the
//       server, just how to open it (in Dropbox, or all of it as a .zip).
//   GET /stream/:token                          (no login: the <video> tag cannot send one; the token is signed, short-lived and only
//       ever names a Dropbox file) → the video, with byte ranges.

const secret = () => process.env.MEDIA_STREAM_SECRET || process.env.JWT_SECRET || '';

/** A file inside a shared folder: the folder link and the path checked again (they come from the query, or from a token). */
const folderFile = (url, p) => {
  const f = dropboxFolderLink(url);
  if (f.error) return { error: f.error };
  const inner = innerPath(p, { allowRoot: false });
  if (!inner) return { error: 'That is not a file inside the folder.' };
  const fileName = path.posix.basename(inner);
  if (!showableInApp(fileName)) return { error: 'The app cannot show this kind of file (it plays mp4, mov, m4v and webm videos and shows jpg, png and webp pictures) — open it in Dropbox.' };
  return { url: f.url, path: inner, fileName };
};

/// The share link as Dropbox knows it (our raw=1 / dl= additions taken off) — what its metadata call is asked about.
const sharedLinkOf = (url) => {
  try {
    const u = new URL(url);
    u.searchParams.delete('raw');
    u.searchParams.delete('dl');
    return u.toString();
  } catch {
    return url;
  }
};

/// With a direct link (the file is in the connected Dropbox — services/mediaDirect.js) the player streams straight from Dropbox; the
/// relay token stays in the answer as the fallback. Dropbox has just said the file is there, so the probe through our server is skipped.
const withDirect = async (out, linkUrl, path, fileName) => {
  const direct = await directLinkFor(linkUrl, path, fileName);
  if (direct) {
    out.direct = direct;
    return true;
  }
  return false;
};

// @route GET /api/marketing/media/link?url=&probe=1[&path=]
const notSetUp = (res) => res.status(503).json({ code: 'not_set_up', message: 'Video playback through the server is not set up.' });

export const getMediaLink = async (req, res) => {
  if (req.query.path !== undefined && req.query.path !== '') {
    const f = folderFile(req.query.url, req.query.path);
    if (f.error) return res.status(400).json({ code: 'not_playable', message: f.error });
    if (!secret()) return notSetUp(res);
    if (!dropboxEnabled()) return res.status(409).json({ code: 'not_connected', message: 'Dropbox is not connected on this server, so files inside a folder cannot be opened here. Open the folder in Dropbox.' });
    const token = signMediaToken(f.url, { secret: secret(), path: f.path });
    const out = { token, path: `/marketing/media/stream/${token}`, fileName: f.fileName, ok: true };
    const direct = await withDirect(out, f.url, f.path, f.fileName);
    if (!direct && String(req.query.probe ?? '') === '1') Object.assign(out, await probeDropbox({ url: f.url, path: f.path }, f.fileName));
    return res.json(out);
  }
  const f = dropboxFileUrl(req.query.url);
  if (f.error) return res.status(400).json({ code: 'not_playable', message: f.error });
  if (!secret()) return notSetUp(res);
  const token = signMediaToken(f.url, { secret: secret() });
  const out = { token, path: `/marketing/media/stream/${token}`, fileName: f.fileName, ok: true };
  const direct = await withDirect(out, sharedLinkOf(f.url), null, f.fileName);
  if (!direct && String(req.query.probe ?? '') === '1') Object.assign(out, await probeDropbox(f.url, f.fileName));
  res.json(out);
};

// @route GET /api/marketing/media/folder?url=&path=&fresh=1
export const getFolder = async (req, res) => {
  const f = dropboxFolderLink(req.query.url);
  if (f.error) return res.status(400).json({ code: 'not_folder', message: f.error });
  const p = innerPath(req.query.path ?? '');
  if (p === null) return res.status(400).json({ code: 'bad_path', message: 'That is not a place inside the folder.' });
  const base = { url: f.url, path: p, zipUrl: folderZipUrl(f.url), connected: dropboxEnabled() };
  if (!base.connected) return res.json({ ...base, ok: false, code: 'not_connected', message: 'Dropbox is not connected to the CRM yet, so the videos inside cannot be listed here. Open the folder in Dropbox, or download it all.' });
  try {
    const listing = await readSharedFolder(f.url, p, { fresh: String(req.query.fresh ?? '') === '1' });
    return res.json({ ...base, ...listing });
  } catch (e) {
    const code = e.code === 'auth' ? 'not_connected' : e.code === 'scope' ? 'scope' : 'unreachable';
    return res.json({ ...base, ok: false, code, message: e.message || 'Dropbox could not be reached just now.' });
  }
};

// @route GET /api/marketing/media/stream/:token
export const streamMedia = async (req, res) => {
  const v = verifyMediaToken(req.params.token, { secret: secret() });
  if (v.error) {
    return res.status(403).json({ code: v.error === 'expired' ? 'expired' : 'bad_link', message: v.error === 'expired' ? 'This video link has expired — open the video again.' : 'This is not a video link the app made.' });
  }
  if (v.path) {
    const f = folderFile(v.url, v.path);
    if (f.error) return res.status(400).json({ code: 'not_playable', message: f.error });
    return streamDropboxFile(req, res, { url: f.url, path: f.path }, f.fileName);
  }
  const f = dropboxFileUrl(v.url);
  if (f.error) return res.status(400).json({ code: 'not_playable', message: f.error });
  await streamDropboxFile(req, res, f.url, f.fileName);
};
