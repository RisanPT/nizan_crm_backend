// Footage from a work (a booking's work day): the artists who worked it put the videos in Dropbox, in a folder named after the work, and
// the link reaches the CRM — Marketing's Creative Portfolio gets it as raw footage, ready to hand to an editor. Pure —
// tests/workFootage.test.js; the records are kept by controllers/workFootageController.js (models/WorkFootage.js).

const lc = (v) => String(v ?? '').trim().toLowerCase();

/** Characters Dropbox does not allow in a name, and runs of space. */
const BAD = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * The folder a work's footage goes in — the same for everyone, so the team always knows where to look:
 * "2026-11-18 · BK-1234 · Amina K · Bridal Makeup". At most 120 characters; no character Dropbox refuses; no trailing dot or space.
 */
export const footageFolderName = (booking, day) => {
  const parts = [day, booking?.bookingNumber, booking?.customerName, booking?.service]
    .map((p) => String(p ?? '').replace(BAD, '-').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return parts.join(' · ').slice(0, 120).replace(/[.\s]+$/, '') || 'Work';
};

/** The full Dropbox path of a work's folder under [root] ("/Team N Works"), filed by month: "/Team N Works/2026-11/…". */
export const footageFolderPath = (root, booking, day) => `${String(root || '/Team N Works').replace(/\/+$/, '')}/${String(day).slice(0, 7)}/${footageFolderName(booking, day)}`;

/**
 * What a pasted link is: { ok, url, provider: 'dropbox' | 'drive', kind: 'folder' | 'file' } — or why it is refused. Dropbox (and, for a
 * team that keeps some footage in Google Drive, a Drive link) only: footage is never a link to anywhere else.
 */
export const footageLinkInfo = (raw) => {
  const s = String(raw ?? '').trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, message: 'Paste the Dropbox link of the uploaded video or folder (it starts with https://www.dropbox.com/).' };
  }
  if (u.protocol !== 'https:') return { ok: false, message: 'The link must start with https://.' };
  const host = lc(u.hostname);
  const path = u.pathname;
  if (host === 'dropbox.com' || host === 'www.dropbox.com' || host === 'db.tt') {
    const folder = /^\/(scl\/fo|sh)\//.test(path) || /^\/home\//.test(path);
    const file = /^\/(scl\/fi|s)\//.test(path);
    if (!folder && !file) return { ok: false, message: 'That Dropbox link does not point to a file or a folder. Use Share → Copy link in Dropbox.' };
    return { ok: true, url: s, provider: 'dropbox', kind: folder ? 'folder' : 'file' };
  }
  if (host === 'drive.google.com') {
    const folder = /\/folders\//.test(path);
    return { ok: true, url: s, provider: 'drive', kind: folder ? 'folder' : 'file' };
  }
  return { ok: false, message: 'Only Dropbox (or Google Drive) links are taken for footage.' };
};

/** The same link twice (Dropbox adds ?dl=0 or a share-tracking query): compared without the query. */
export const sameFootageLink = (a, b) => {
  const strip = (x) => String(x ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return strip(a) === strip(b);
};

export const FOOTAGE_STATUSES = ['new', 'in_edit', 'edited'];

/** Where a work's footage stands: nothing yet (waiting), new (arrived, nobody editing), in_edit, edited. */
export const footageState = (rec) => {
  if (!rec || (!(rec.links ?? []).length && !(rec.files ?? []).length)) return 'waiting';
  return FOOTAGE_STATUSES.includes(rec.status) ? rec.status : 'new';
};

/**
 * Is footage expected from this work day and not in yet? A work that needs content (the booking asks for it, or a shoot covers it),
 * whose day has come (today counts — it is uploaded once the work is done), with nothing uploaded.
 */
export const footageDue = ({ needsContent, day, today, rec }) => !!needsContent && !!day && day <= today && footageState(rec) === 'waiting';

/** A size in words: "820 MB", "2.4 GB"; '' when unknown. */
export const sizeLabel = (bytes) => {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024 ** 3) return `${Math.max(1, Math.round(b / 1024 ** 2))} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
};

/** The files of a Dropbox listing that are footage (videos and pictures), newest first, with their total size. */
export const footageFiles = (entries) => {
  const files = (entries ?? [])
    .filter((e) => (e['.tag'] ?? e.tag) === 'file')
    .map((e) => ({ name: e.name, path: e.path_display ?? e.path_lower ?? '', size: Number(e.size) || 0, modifiedAt: e.client_modified ?? e.server_modified ?? null }))
    .sort((a, b) => String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')));
  return { files, totalBytes: files.reduce((t, f) => t + f.size, 0) };
};
