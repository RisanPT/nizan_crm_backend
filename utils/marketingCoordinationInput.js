import mongoose from 'mongoose';
import { isDay } from './marketingActivityInput.js';
import { httpUrl } from './marketingSocialsInput.js';
import {
  DEPARTMENTS, APPROVAL_CATEGORIES, PRIORITIES, REQUEST_STATUSES, MEETING_STATUSES, FOLLOWUP_STATUSES, STATUS_LABEL, canMoveRequest,
} from './marketingCoordinationStats.js';

// Checking what the app sends for a request, an approval, a meeting and a follow-up (pure — tests/marketingCoordinationInput.test.js).
// The controller adds the checks that need the database (does that member exist, who may change this record). Text is data: it is trimmed
// and capped, never interpreted; links must be http(s).
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const fail = (message, field) => ({ ok: false, message, field });
const idOrNull = (v) => (v && mongoose.isValidObjectId(String(v)) ? String(v) : null);
const BRANDS = ['main', 'kerala'];
const has = (b, k) => b[k] !== undefined;

const brandOf = (b, out) => {
  if (!has(b, 'brand')) return null;
  if (!BRANDS.includes(b.brand)) return fail('Choose Main or Kerala.', 'brand');
  out.brand = b.brand;
  return null;
};
const dayOf = (v) => (v === null || v === '' ? null : v);

/** An optional member reference: a valid id, or null to clear. An id of the wrong shape is a refusal. */
const memberRef = (b, key, out, message) => {
  if (!has(b, key)) return null;
  if (b[key] === null || b[key] === '') {
    out[key] = null;
    return null;
  }
  const id = idOrNull(b[key]);
  if (!id) return fail(message, key);
  out[key] = id;
  return null;
};

// ── requests and handovers ────────────────────────────────────────────────────

/**
 * A request (or handover) from a request body. `existing` set = an update (only what was sent changes; the kind cannot change).
 * → { ok: true, value } | { ok: false, message, field }. `value.status` is set only when it was sent.
 */
export const cleanRequestInput = (b = {}, existing = null) => {
  const out = {};
  if (has(b, 'title') || !existing) {
    out.title = str(b.title, 200);
    if (out.title.length < 2) return fail('Give the request a title.', 'title');
  }
  if (!existing) {
    out.kind = b.kind === undefined || b.kind === '' ? 'request' : b.kind;
    if (!['request', 'handover'].includes(out.kind)) return fail('A request is either a request or a handover.', 'kind');
  }
  if (has(b, 'detail')) out.detail = str(b.detail, 2000);
  if (has(b, 'fromDept') || !existing) {
    const from = has(b, 'fromDept') ? b.fromDept : 'Marketing';
    if (!DEPARTMENTS.includes(from)) return fail('Choose the team the request comes from.', 'fromDept');
    out.fromDept = from;
  }
  if (has(b, 'toDept') || !existing) {
    if (!DEPARTMENTS.includes(b.toDept)) return fail('Choose the team the request is for.', 'toDept');
    out.toDept = b.toDept;
  }
  if (has(b, 'priority')) {
    if (!PRIORITIES.includes(b.priority)) return fail('Priority is High, Medium or Low.', 'priority');
    out.priority = b.priority;
  }
  if (has(b, 'dueDate')) {
    const d = dayOf(b.dueDate);
    if (d !== null && !isDay(d)) return fail('The due date must be a real day.', 'dueDate');
    out.dueDate = d;
  }
  if (has(b, 'progress')) {
    const n = Number(b.progress);
    if (b.progress === '' || b.progress === null || !Number.isFinite(n) || n < 0 || n > 100) return fail('Progress is a number from 0 to 100.', 'progress');
    out.progress = Math.round(n);
  }
  const brand = brandOf(b, out);
  if (brand) return brand;
  for (const [key, message] of [['assigneeId', 'Unknown team member.'], ['requestedById', 'Unknown team member.']]) {
    const r = memberRef(b, key, out, message);
    if (r) return r;
  }
  if (has(b, 'assigneeName')) out.assigneeName = str(b.assigneeName, 100);
  if (has(b, 'status')) {
    if (!REQUEST_STATUSES.includes(b.status)) return fail('Unknown status.', 'status');
    if (!existing && !['open', 'in_progress'].includes(b.status)) return fail('A new request starts Open or In Progress.', 'status');
    if (existing && !canMoveRequest(existing.status, b.status)) return fail(`A request that is ${STATUS_LABEL[existing.status]} cannot be moved to ${STATUS_LABEL[b.status]}.`, 'status');
    out.status = b.status;
  }
  return { ok: true, value: out };
};

// ── approvals ─────────────────────────────────────────────────────────────────

/** An approval request from a request body (the amount is only recorded — nothing is posted to accounts). */
export const cleanApprovalInput = (b = {}, existing = null) => {
  const out = {};
  if (has(b, 'title') || !existing) {
    out.title = str(b.title, 200);
    if (out.title.length < 2) return fail('Say what needs approving.', 'title');
  }
  if (has(b, 'category') || !existing) {
    if (!APPROVAL_CATEGORIES.includes(b.category)) return fail('Choose a category.', 'category');
    out.category = b.category;
  }
  if (has(b, 'amount')) {
    const raw = b.amount === '' || b.amount === null ? 0 : Number(b.amount);
    if (!Number.isFinite(raw) || raw < 0 || raw > 1_000_000_000) return fail('The amount must be zero or more.', 'amount');
    out.amount = Math.round(raw * 100) / 100;
  }
  if (has(b, 'impact')) out.impact = str(b.impact, 500);
  if (has(b, 'dueDate')) {
    const d = dayOf(b.dueDate);
    if (d !== null && !isDay(d)) return fail('The needed-by date must be a real day.', 'dueDate');
    out.dueDate = d;
  }
  const brand = brandOf(b, out);
  if (brand) return brand;
  if (has(b, 'requestId')) {
    if (b.requestId === null || b.requestId === '') out.requestId = null;
    else if (idOrNull(b.requestId)) out.requestId = String(b.requestId);
    else return fail('Unknown request.', 'requestId');
  }
  const by = memberRef(b, 'requestedById', out, 'Unknown team member.');
  if (by) return by;
  return { ok: true, value: out };
};

/** A decision on an approval: review, approve, reject (a note is needed), escalate. */
export const cleanDecisionInput = (b = {}) => {
  const decision = String(b.decision ?? '');
  if (!['review', 'approve', 'reject', 'escalate'].includes(decision)) return fail('Choose approve, reject, escalate or review.', 'decision');
  const note = str(b.note, 1000);
  if (decision === 'reject' && note.length < 3) return fail('Say why it is rejected, so the requester knows.', 'note');
  return { ok: true, value: { decision, note } };
};

// ── meetings ──────────────────────────────────────────────────────────────────

const instant = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t;
};

/** A meeting from a request body. Times are ISO instants (the app sends the IST wall time as UTC). */
export const cleanMeetingInput = (b = {}, existing = null) => {
  const out = {};
  if (has(b, 'title') || !existing) {
    out.title = str(b.title, 200);
    if (out.title.length < 2) return fail('Give the meeting a title.', 'title');
  }
  if (has(b, 'startAt') || !existing) {
    out.startAt = instant(b.startAt);
    if (!out.startAt) return fail('Choose when the meeting starts.', 'startAt');
  }
  if (has(b, 'endAt') || !existing) {
    out.endAt = instant(b.endAt);
    if (!out.endAt) return fail('Choose when the meeting ends.', 'endAt');
  }
  const start = out.startAt ?? existing?.startAt;
  const end = out.endAt ?? existing?.endAt;
  if (start && end) {
    if (new Date(end) <= new Date(start)) return fail('The meeting has to end after it starts.', 'endAt');
    if (new Date(end) - new Date(start) > 24 * 3600 * 1000) return fail('A meeting is at most 24 hours long.', 'endAt');
  }
  if (has(b, 'location')) out.location = str(b.location, 160);
  if (has(b, 'link')) {
    out.link = httpUrl(b.link);
    if (str(b.link, 1000) && !out.link) return fail('The meeting link must start with https://.', 'link');
  }
  if (has(b, 'status')) {
    if (!MEETING_STATUSES.includes(b.status)) return fail('Unknown meeting status.', 'status');
    out.status = b.status;
  }
  if (has(b, 'notes')) out.notes = str(b.notes, 4000);
  const brand = brandOf(b, out);
  if (brand) return brand;
  if (has(b, 'departments')) {
    if (!Array.isArray(b.departments)) return fail('The departments must be a list.', 'departments');
    if (b.departments.some((d) => !DEPARTMENTS.includes(d))) return fail('Unknown department.', 'departments');
    out.departments = [...new Set(b.departments)];
  }
  if (has(b, 'agenda')) {
    if (!Array.isArray(b.agenda)) return fail('The agenda must be a list.', 'agenda');
    if (b.agenda.length > 20) return fail('An agenda has at most 20 points.', 'agenda');
    out.agenda = b.agenda.map((a) => str(a, 200)).filter(Boolean);
  }
  if (has(b, 'attendees')) {
    if (!Array.isArray(b.attendees)) return fail('The attendees must be a list.', 'attendees');
    if (b.attendees.length > 40) return fail('A meeting has at most 40 attendees.', 'attendees');
    const seen = new Set();
    out.attendees = [];
    for (const a of b.attendees) {
      const memberId = idOrNull(a?.memberId);
      if (a?.memberId && !memberId) return fail('An attendee names an unknown team member.', 'attendees');
      const name = str(a?.name, 100);
      if (!memberId && !name) continue;
      const key = memberId ?? name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.attendees.push({ memberId, name: memberId ? '' : name });
    }
  }
  if (has(b, 'actionItems')) {
    if (!Array.isArray(b.actionItems)) return fail('The action items must be a list.', 'actionItems');
    if (b.actionItems.length > 30) return fail('A meeting has at most 30 action items.', 'actionItems');
    out.actionItems = [];
    for (const it of b.actionItems) {
      const text = str(it?.text, 300);
      if (text.length < 2) return fail('Each action item needs a few words.', 'actionItems');
      const ownerId = idOrNull(it?.ownerId);
      if (it?.ownerId && !ownerId) return fail('An action item names an unknown owner.', 'actionItems');
      const due = dayOf(it?.due ?? null);
      if (due !== null && !isDay(due)) return fail('An action item due date must be a real day.', 'actionItems');
      out.actionItems.push({ id: idOrNull(it?.id), text, ownerId, ownerName: ownerId ? '' : str(it?.ownerName, 100), due, done: it?.done === true });
    }
  }
  return { ok: true, value: out };
};

// ── follow-ups ────────────────────────────────────────────────────────────────

/** A follow-up from a request body. */
export const cleanFollowUpInput = (b = {}, existing = null) => {
  const out = {};
  if (has(b, 'item') || !existing) {
    out.item = str(b.item, 300);
    if (out.item.length < 2) return fail('Say what needs following up.', 'item');
  }
  if (has(b, 'relatedTo')) out.relatedTo = str(b.relatedTo, 200);
  if (has(b, 'department') || !existing) {
    const d = has(b, 'department') ? b.department : 'Marketing';
    if (!DEPARTMENTS.includes(d)) return fail('Choose a department.', 'department');
    out.department = d;
  }
  if (has(b, 'dueDate') || !existing) {
    if (!isDay(b.dueDate)) return fail('Choose the day it is due.', 'dueDate');
    out.dueDate = b.dueDate;
  }
  if (has(b, 'status')) {
    if (!FOLLOWUP_STATUSES.includes(b.status)) return fail('A follow-up is Open or Done.', 'status');
    out.status = b.status;
  }
  if (has(b, 'reminder')) out.reminder = b.reminder === true;
  const owner = memberRef(b, 'ownerId', out, 'Unknown team member.');
  if (owner) return owner;
  if (has(b, 'ownerName')) out.ownerName = str(b.ownerName, 100);
  if (has(b, 'meetingId')) {
    if (b.meetingId === null || b.meetingId === '') out.meetingId = null;
    else if (idOrNull(b.meetingId)) out.meetingId = String(b.meetingId);
    else return fail('Unknown meeting.', 'meetingId');
  }
  const brand = brandOf(b, out);
  if (brand) return brand;
  return { ok: true, value: out };
};
