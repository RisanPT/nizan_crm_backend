// The rules of a CRM CASE (models/CrmCase.js) — when one is due, what a review opens, which status changes are allowed and who may
// make them. Pure — tests/crmCaseRules.test.js.

const HOUR_MS = 3600 * 1000;
const lc = (v) => String(v ?? '').trim().toLowerCase();
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

/// A phone as a client is matched by: its last 10 digits ("+91 98950 00001" and "9895000001" are the same client).
export { normalizePhone } from './phone.js';

/// The time limit (hours) of a case of [kind], from the CRM settings.
export const caseSlaHoursFor = (settings, kind) => Number(settings?.caseSlaHours?.[kind]) || 48;

/// When a case opened at [from] with a time limit of [hours] is due.
export const dueAtFor = (from, hours) => new Date(new Date(from).getTime() + Math.max(1, Number(hours) || 1) * HOUR_MS);

/// Still being worked on?
export const isOpenCase = (c) => c?.status === 'open' || c?.status === 'in_progress';

/// Past its due time and still open.
export const isOverdue = (c, now = new Date()) => isOpenCase(c) && !!c.dueAt && new Date(c.dueAt) < now;

/// Resolved by its due time (a case closed without being resolved never counts as on time).
export const resolvedOnTime = (c) => !!c?.resolvedAt && !!c?.dueAt && new Date(c.resolvedAt) <= new Date(c.dueAt);

/**
 * The cases a SUBMITTED review opens: a complaint when the client was unhappy (the review is flagged a complaint, or the NPS is at
 * or under [lowNps]), and a follow-up when staff asked for one.
 */
export const reviewCaseKinds = (review, { lowNps = 6 } = {}) => {
  const kinds = [];
  const npsLow = review?.nps != null && review.nps !== '' && Number(review.nps) <= lowNps;
  if (review?.complaint === true || npsLow) kinds.push('complaint');
  if (review?.followUpRequired === true) kinds.push('follow_up');
  return kinds;
};

/// The cases a staff EDIT of a review opens: only for a flag that was just switched on (an older complaint someone merely re-saves
/// opens nothing).
export const flippedCaseKinds = (before, after) => {
  const kinds = [];
  if (before?.complaint !== true && after?.complaint === true) kinds.push('complaint');
  if (before?.followUpRequired !== true && after?.followUpRequired === true) kinds.push('follow_up');
  return kinds;
};

const NEXT = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['open', 'resolved', 'closed'],
  resolved: ['open'],
  closed: ['open'],
};

/**
 * May [actor] (a viewer from utils/crmAccess.js crmViewerOf, plus their user id) change [c]? `next` is the status asked for (or
 * nothing for an edit that keeps it); `note` is the resolution note. Returns the refusal (a message) or null.
 */
export const caseChangeRefusal = (c, { viewer, actorId, next, note }) => {
  if (viewer === 'leadership' || viewer === 'none') return 'You can only look at cases.';
  const head = viewer === 'admin' || viewer === 'head';
  if (!head && idOf(c?.ownerId) !== idOf(actorId)) return 'Only the case owner or the CRM Head can change this case.';
  const from = c?.status ?? 'open';
  const to = lc(next);
  if (!to || to === from) return null;
  if (!(NEXT[from] ?? []).includes(to)) return `A ${from.replace('_', ' ')} case cannot become ${to.replace('_', ' ')}.`;
  if ((from === 'resolved' || from === 'closed') && !head) return 'Only the CRM Head can reopen a case.';
  if ((to === 'resolved' || to === 'closed') && String(note ?? c?.resolutionNote ?? '').trim().length < 3) {
    return 'Write what was done before resolving or closing the case.';
  }
  return null;
};

/// The case number: "CC-YYMMDD-" and four random characters (retried by the caller on the rare clash).
export const caseNumberCandidate = (now = new Date()) => {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  const ymd = ist.toISOString().slice(2, 10).replace(/-/g, '');
  const tail = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, '0');
  return `CC-${ymd}-${tail}`;
};
