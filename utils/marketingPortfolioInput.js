import mongoose from 'mongoose';
import { SHOOT_STATUSES, MILESTONE_KEYS, OUTPUT_KEYS } from '../models/MarketingShoot.js';
import { isDay } from './marketingActivityInput.js';
import { httpUrl } from './marketingSocialsInput.js';
import { MAX_MOODBOARD, moodboardKind } from './shootBoard.js';

// Checking what the app sends for a shoot plan (pure — tests/marketingPortfolioInput.test.js).
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const fail = (message, field) => ({ ok: false, message, field });
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A shoot from a request body. `existing` set = an update (only what was sent changes). */
export const cleanShootInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (has('title') || !existing) {
    out.title = str(b.title, 200);
    if (out.title.length < 2) return fail('Give the shoot a title.', 'title');
  }
  if (has('shootDate') || !existing) {
    if (!isDay(b.shootDate)) return fail('Choose the date of the shoot.', 'shootDate');
    out.shootDate = b.shootDate;
  }
  if (has('brand')) {
    if (!['main', 'kerala'].includes(b.brand)) return fail('Choose Main or Kerala.', 'brand');
    out.brand = b.brand;
  }
  if (has('status')) {
    if (!SHOOT_STATUSES.includes(b.status)) return fail('Unknown shoot status.', 'status');
    out.status = b.status;
  }
  for (const k of ['startTime', 'endTime']) {
    if (!has(k)) continue;
    const t = str(b[k], 5);
    if (t && !TIME_RE.test(t)) return fail('A time must look like 09:30.', k);
    out[k] = t;
  }
  if ((out.startTime ?? existing?.startTime) && (out.endTime ?? existing?.endTime) && (out.endTime ?? existing.endTime) <= (out.startTime ?? existing.startTime)) return fail('The shoot has to end after it starts.', 'endTime');
  for (const [k, max] of [['pillar', 120], ['category', 80], ['shootType', 60], ['location', 160]]) if (has(k)) out[k] = str(b[k], max);
  if (has('coverUrl')) {
    out.coverUrl = httpUrl(b.coverUrl);
    if (str(b.coverUrl, 1000) && !out.coverUrl) return fail('The cover picture must be a link starting with https://.', 'coverUrl');
  }
  if (has('brief')) {
    const x = b.brief && typeof b.brief === 'object' ? b.brief : {};
    out.brief = { objective: str(x.objective, 1000), audience: str(x.audience, 300), notes: str(x.notes, 2000) };
  }
  if (has('planned')) {
    const x = b.planned && typeof b.planned === 'object' ? b.planned : {};
    out.planned = {};
    for (const k of OUTPUT_KEYS) {
      if (x[k] === undefined || x[k] === null || x[k] === '') {
        out.planned[k] = 0;
        continue;
      }
      const n = Number(x[k]);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return fail('Planned outputs must be whole numbers, zero or more.', 'planned');
      out.planned[k] = n;
    }
  }
  if (has('crew')) {
    if (!Array.isArray(b.crew)) return fail('The crew must be a list.', 'crew');
    if (b.crew.length > 40) return fail('That is too many crew members.', 'crew');
    const oid = (v) => (v && mongoose.isValidObjectId(String(v)) ? String(v) : null);
    out.crew = b.crew.map((c) => ({ memberId: oid(c?.memberId), employeeId: oid(c?.employeeId), name: str(c?.name, 100), role: str(c?.role, 80) })).filter((c) => c.memberId || c.employeeId || c.name);
  }
  if (has('milestones')) {
    if (!Array.isArray(b.milestones)) return fail('The milestones must be a list.', 'milestones');
    const seen = new Set();
    out.milestoneDates = [];
    for (const m of b.milestones) {
      if (!m || !MILESTONE_KEYS.includes(m.key)) return fail('Unknown milestone.', 'milestones');
      if (seen.has(m.key)) return fail('A milestone is listed twice.', 'milestones');
      seen.add(m.key);
      if (m.date !== null && m.date !== undefined && m.date !== '' && !isDay(m.date)) return fail('A milestone date must be a real day.', 'milestones');
      out.milestoneDates.push({ key: m.key, date: m.date || null });
    }
  }
  if (has('references')) {
    if (!Array.isArray(b.references)) return fail('The references must be a list of links.', 'references');
    if (b.references.length > MAX_MOODBOARD) return fail(`Add at most ${MAX_MOODBOARD} references.`, 'references');
    out.references = [];
    for (const r of b.references) {
      const url = httpUrl(typeof r === 'string' ? r : r?.url);
      if (!url) return fail('Each reference must be a link starting with https://.', 'references');
      out.references.push({ label: str(typeof r === 'string' ? '' : r?.label, 120), url, kind: moodboardKind(url) });
    }
  }
  if (has('bookingId')) {
    if (b.bookingId === null || b.bookingId === '') out.bookingId = null;
    else if (!mongoose.isValidObjectId(String(b.bookingId))) return fail('That booking was not found.', 'bookingId');
    else out.bookingId = String(b.bookingId);
  }
  if (has('storyboard')) {
    const v = cleanStoryboard(b.storyboard);
    if (!v.ok) return v;
    out.storyboard = v.value;
  }
  return { ok: true, value: out };
};

/**
 * The storyboard: frames in shooting order, each with a description; shot no. (the position when left blank), shot type, duration in
 * seconds, a reference link and a picture (https only), notes, and the key the frame had.
 */
export const cleanStoryboard = (list) => {
  if (!Array.isArray(list)) return fail('The storyboard must be a list of frames.', 'storyboard');
  if (list.length > 100) return fail('A storyboard can have at most 100 frames.', 'storyboard');
  const frames = [];
  for (const [i, f] of list.entries()) {
    const description = str(f?.description, 500);
    if (!description) return fail(`Frame ${i + 1} needs a description.`, 'storyboard');
    const d = f?.durationSec === undefined || f?.durationSec === null || f?.durationSec === '' ? 0 : Number(f.durationSec);
    if (!Number.isFinite(d) || d < 0 || d > 3600) return fail(`Frame ${i + 1}: the duration must be seconds, from 0 to 3600.`, 'storyboard');
    const referenceUrl = httpUrl(f?.referenceUrl);
    if (str(f?.referenceUrl, 1000) && !referenceUrl) return fail(`Frame ${i + 1}: the reference must be a link starting with https://.`, 'storyboard');
    // the frame's picture: a sketch or a still uploaded from the phone, or a picture from the moodboard
    const imageUrl = httpUrl(f?.imageUrl);
    if (str(f?.imageUrl, 1000) && !imageUrl) return fail(`Frame ${i + 1}: the picture must be a link starting with https://.`, 'storyboard');
    // the key the frame already had (kept so its "shot" tick stays — utils/shootBoard.js mergeStoryboard); never the tick itself
    const key = str(f?.key, 40);
    frames.push({ ...(key ? { key } : {}), shotNo: str(f?.shotNo, 12) || String(i + 1), description, shotType: str(f?.shotType, 60), durationSec: Math.round(d), referenceUrl, imageUrl, notes: str(f?.notes, 500) });
  }
  return { ok: true, value: frames };
};

/** The default milestone dates for a new shoot: brief 3 days before, pre-production 2 days before, production on the day, post-production +2, distribution +4. */
export const defaultMilestoneDates = (shootDate, addDays) => ({ brief: addDays(shootDate, -3), pre_production: addDays(shootDate, -2), production: shootDate, post_production: addDays(shootDate, 2), distribution: addDays(shootDate, 4) });
