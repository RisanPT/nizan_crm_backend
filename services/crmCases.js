import CrmCase from '../models/CrmCase.js';
import Booking from '../models/Booking.js';
import { getCrmSettings } from './crmSettings.js';
import { crmHeadIds } from './crmTeam.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';
import { caseNumberCandidate, caseSlaHoursFor, dueAtFor, normalizePhone } from '../utils/crmCaseRules.js';

// Opening CRM cases (models/CrmCase.js): by hand, from a flagged review (once per review and kind), or from the list of past clients
// to call. A new case's owner is told it is theirs; the CRM Head is told about a case that opened by itself.

const KIND_LABEL = { complaint: 'Complaint', follow_up: 'Follow-up', re_engagement: 'Re-engagement call', trial_follow_up: 'Trial follow-up' };
export const caseKindLabel = (k) => KIND_LABEL[k] ?? 'Case';

const actorFields = (actor) => ({ createdBy: actor?._id ?? null, createdByName: actor?.name ?? '' });

/// A unique case number (retries on the rare clash).
export const newCaseNumber = async (now = new Date()) => {
  for (let i = 0; i < 8; i += 1) {
    const n = caseNumberCandidate(now);
    if (!(await CrmCase.exists({ caseNumber: n }))) return n;
  }
  return `CC-${Date.now()}`;
};

const tellOwner = async (c, actor) => {
  if (!c.ownerId || String(c.ownerId) === String(actor?._id ?? '')) return;
  await notify({
    recipients: [c.ownerId],
    type: NOTIFICATION_TYPES.CRM_ASSIGNED,
    title: `${caseKindLabel(c.kind)} for you: ${c.customerName || c.title}`,
    body: `${c.caseNumber} · due ${new Date(c.dueAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}`,
    link: `/crm/cases/${c._id}`,
    createdBy: actor?._id ?? null,
  });
};

/**
 * Opens a case by hand (or from a list). [fields] carries kind, title, description, priority, customerName, phone, the links, origin and
 * ownerId / ownerName. Returns the saved case. `notifyOwner: false` when the caller tells the owner itself (many cases at once).
 */
export const openCase = async (fields, actor, now = new Date(), { notifyOwner = true } = {}) => {
  const settings = await getCrmSettings();
  const slaHours = Number(fields.slaHours) || caseSlaHoursFor(settings, fields.kind);
  const owner = fields.ownerId ? { ownerId: fields.ownerId, ownerName: fields.ownerName ?? '', assignedAt: now, assignedBy: actor?._id ?? null } : {};
  const c = await CrmCase.create({
    ...fields,
    phone: normalizePhone(fields.phone),
    caseNumber: await newCaseNumber(now),
    slaHours,
    dueAt: dueAtFor(now, slaHours),
    status: 'open',
    ...owner,
    ...actorFields(actor),
    activities: [{ type: 'note', text: `Opened (${caseKindLabel(fields.kind).toLowerCase()})`, at: now, by: actor?._id ?? null, byName: actor?.name ?? '' }],
  });
  if (notifyOwner) {
    try {
      await tellOwner(c, actor);
    } catch (e) {
      console.error('crm case notify failed:', e.message);
    }
  }
  return c;
};

/**
 * The cases a review opens, of the given [kinds] — at most ONE of each kind per review, however many times this runs (a unique index
 * backs it). The owner is the booking's CRM owner; with none, the case waits in Unassigned. The CRM Head (and the owner) are told about
 * each case that is new. Returns the cases that were opened now.
 */
export const openReviewCases = async (review, kinds, actor = null, now = new Date()) => {
  if (!review || !kinds?.length) return [];
  const settings = await getCrmSettings();
  const booking = review.booking ? await Booking.findById(review.booking).select('crmOwnerId crmOwnerName phone customerName').lean() : null;
  const opened = [];
  for (const kind of kinds) {
    const slaHours = caseSlaHoursFor(settings, kind);
    const title =
      kind === 'complaint'
        ? `Unhappy client: ${review.brideName || 'review'}${review.nps != null ? ` (NPS ${review.nps})` : ''}`
        : `Follow up: ${review.brideName || 'review'}`;
    const doc = {
      caseNumber: await newCaseNumber(now),
      kind,
      title,
      description: [review.managerComments, review.testimonial].filter(Boolean).join('\n'),
      priority: kind === 'complaint' ? 'high' : 'normal',
      customerName: review.brideName || booking?.customerName || '',
      phone: normalizePhone(review.customerPhone || booking?.phone),
      bookingId: review.booking ?? null,
      reviewId: review._id,
      origin: 'review_auto',
      ownerId: booking?.crmOwnerId ?? null,
      ownerName: booking?.crmOwnerName ?? '',
      assignedAt: booking?.crmOwnerId ? now : null,
      status: 'open',
      slaHours,
      dueAt: dueAtFor(now, slaHours),
      ...actorFields(actor),
      activities: [{ type: 'note', text: 'Opened from the client review', at: now, by: actor?._id ?? null, byName: actor?.name ?? '' }],
    };
    try {
      const r = await CrmCase.findOneAndUpdate(
        { reviewId: review._id, kind, origin: 'review_auto' },
        { $setOnInsert: doc },
        { upsert: true, new: true, includeResultMetadata: true }
      );
      if (r?.lastErrorObject?.updatedExisting === false && r.value) opened.push(r.value);
    } catch (e) {
      if (e?.code !== 11000) throw e; // two saves at once: the other one opened it
    }
  }
  for (const c of opened) {
    try {
      const heads = (await crmHeadIds()).filter((id) => String(id) !== String(c.ownerId ?? ''));
      await notify({
        recipients: heads,
        type: NOTIFICATION_TYPES.CRM_CASE_OPENED,
        title: `${caseKindLabel(c.kind)}: ${c.customerName || c.title}`,
        body: `${c.caseNumber} · ${c.ownerName ? `owner ${c.ownerName}` : 'not assigned yet'}`,
        link: `/crm/cases/${c._id}`,
      });
      await tellOwner(c, actor);
    } catch (e) {
      console.error('crm case notify failed:', e.message);
    }
  }
  return opened;
};
