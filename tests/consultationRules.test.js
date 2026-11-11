// Pure unit tests (no database, no server): node --test tests/consultationRules.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Consultation, { generateConsultationNo } from '../models/Consultation.js';
import {
  accessFor,
  buildConsultationNotice,
  canActOn,
  canSeeNotes,
  deriveClientStatus,
  describeSlot,
  detectProvider,
  dueReminderKey,
  historyEntry,
  initialRemindersSent,
  intervalsOverlap,
  tiersUpTo,
  normalizeMeetingLink,
  parseSchedule,
  permissionGranted,
  redactConsultation,
} from '../utils/consultationRules.js';

const id = () => new mongoose.Types.ObjectId();
const user = (role, permissions = []) => ({ _id: id(), role, permissions, name: 'U' });

// ── Access ──────────────────────────────────────────────────────────────────
test('permissionGranted: parent key means the whole module, sub-key is exact', () => {
  assert.equal(permissionGranted(['consultations'], 'consultations.notes'), true);
  assert.equal(permissionGranted(['consultations.calendar'], 'consultations.notes'), false);
  assert.equal(permissionGranted(['consultations.notes'], 'consultations.notes'), true);
  assert.equal(permissionGranted([], 'consultations.notes'), false);
  assert.equal(permissionGranted(undefined, 'consultations'), false);
});

test('accessFor: admin/manager have blanket access', () => {
  for (const role of ['admin', 'manager', 'Manager ']) {
    const a = accessFor(user(role));
    assert.deepEqual([a.hasModule, a.viewAll, a.notesPermission], [true, true, true]);
  }
});

test('accessFor: stylist (sub-key only) sees own work, no notes permission', () => {
  const a = accessFor(user('stylist', ['consultations.calendar']));
  assert.equal(a.hasModule, true);
  assert.equal(a.viewAll, false);
  assert.equal(a.notesPermission, false);
});

test('accessFor: stylist lead (parent key) sees all and notes', () => {
  const a = accessFor(user('stylist_lead', ['consultations']));
  assert.deepEqual([a.hasModule, a.viewAll, a.notesPermission], [true, true, true]);
});

test('accessFor: unrelated roles and unknown users have no access', () => {
  assert.equal(accessFor(user('sales', ['sales', 'clients'])).hasModule, false);
  assert.equal(accessFor(null).hasModule, false);
  assert.equal(accessFor(user('sales_manager')).hasModule, false);
});

test('canActOn / canSeeNotes: a stylist is limited to their own consultation', () => {
  const stylist = user('stylist', ['consultations.calendar']);
  const access = accessFor(stylist);
  const mine = { stylistId: stylist._id };
  const theirs = { stylistId: id() };
  assert.equal(canActOn(access, stylist, mine), true);
  assert.equal(canActOn(access, stylist, theirs), false);
  assert.equal(canSeeNotes(access, stylist, mine), true);
  assert.equal(canSeeNotes(access, stylist, theirs), false);
});

test('canActOn works when stylistId is a populated document', () => {
  const stylist = user('stylist', ['consultations.calendar']);
  const access = accessFor(stylist);
  assert.equal(canActOn(access, stylist, { stylistId: { _id: stylist._id, name: 'S' } }), true);
});

test('redactConsultation strips notes unless allowed', () => {
  const stylist = user('stylist', ['consultations.calendar']);
  const access = accessFor(stylist);
  const row = { stylistId: id(), notes: 'secret', preferences: 'p', nextSteps: 'n', status: 'Scheduled' };
  const out = redactConsultation(row, access, stylist);
  assert.equal('notes' in out, false);
  assert.equal('preferences' in out, false);
  assert.equal('nextSteps' in out, false);
  assert.equal(out.status, 'Scheduled');

  const own = redactConsultation({ ...row, stylistId: stylist._id }, access, stylist);
  assert.equal(own.notes, 'secret');

  const lead = user('stylist_lead', ['consultations']);
  assert.equal(redactConsultation(row, accessFor(lead), lead).notes, 'secret');
  // The input is never mutated.
  assert.equal(row.notes, 'secret');
});

// ── Schedule ────────────────────────────────────────────────────────────────
test('parseSchedule: valid input, default duration, end time', () => {
  const r = parseSchedule({ scheduledAt: '2026-11-02T10:00:00+05:30' });
  assert.equal(r.ok, true);
  assert.equal(r.durationMins, 45);
  assert.equal(r.start.toISOString(), '2026-11-02T04:30:00.000Z');
  assert.equal(r.end.toISOString(), '2026-11-02T05:15:00.000Z');
});

test('parseSchedule: rejects missing timezone, garbage, and bad durations', () => {
  assert.equal(parseSchedule({ scheduledAt: '2026-11-02T10:00:00' }).ok, false);
  assert.equal(parseSchedule({ scheduledAt: 'tomorrow' }).ok, false);
  assert.equal(parseSchedule({ scheduledAt: undefined }).ok, false);
  assert.equal(parseSchedule({ scheduledAt: 1790000000000 }).ok, false);
  const at = '2026-11-02T04:30:00Z';
  assert.equal(parseSchedule({ scheduledAt: at, durationMins: 0 }).ok, false);
  assert.equal(parseSchedule({ scheduledAt: at, durationMins: 481 }).ok, false);
  assert.equal(parseSchedule({ scheduledAt: at, durationMins: 30.5 }).ok, false);
  assert.equal(parseSchedule({ scheduledAt: at, durationMins: 'abc' }).ok, false);
  assert.equal(parseSchedule({ scheduledAt: at, durationMins: '60' }).durationMins, 60);
});

// ── Conflicts ───────────────────────────────────────────────────────────────
test('intervalsOverlap: overlap, containment, and back-to-back', () => {
  const t = (hhmm) => new Date(`2026-11-02T${hhmm}:00Z`);
  assert.equal(intervalsOverlap(t('10:00'), t('10:45'), t('10:30'), t('11:15')), true);
  assert.equal(intervalsOverlap(t('10:00'), t('12:00'), t('10:30'), t('11:00')), true);
  assert.equal(intervalsOverlap(t('10:30'), t('11:00'), t('10:00'), t('12:00')), true);
  assert.equal(intervalsOverlap(t('10:00'), t('10:45'), t('10:00'), t('10:45')), true);
  // Back-to-back slots do not clash.
  assert.equal(intervalsOverlap(t('10:00'), t('10:45'), t('10:45'), t('11:30')), false);
  assert.equal(intervalsOverlap(t('10:45'), t('11:30'), t('10:00'), t('10:45')), false);
  assert.equal(intervalsOverlap(t('09:00'), t('09:30'), t('10:00'), t('10:45')), false);
});

// ── Meeting link ────────────────────────────────────────────────────────────
test('normalizeMeetingLink: accepts pasted links, adds a missing scheme', () => {
  assert.deepEqual(normalizeMeetingLink(''), { ok: true, value: '' });
  assert.deepEqual(normalizeMeetingLink(null), { ok: true, value: '' });
  assert.equal(normalizeMeetingLink('  https://meet.google.com/abc-defg-hij ').value, 'https://meet.google.com/abc-defg-hij');
  assert.equal(normalizeMeetingLink('meet.google.com/abc-defg-hij').value, 'https://meet.google.com/abc-defg-hij');
  assert.equal(normalizeMeetingLink('https://us02web.zoom.us/j/123?pwd=x').ok, true);
});

test('normalizeMeetingLink: rejects unsafe or invalid values', () => {
  assert.equal(normalizeMeetingLink('javascript:alert(1)').ok, false);
  assert.equal(normalizeMeetingLink('ftp://example.com/x').ok, false);
  assert.equal(normalizeMeetingLink('not a link').ok, false);
  assert.equal(normalizeMeetingLink(`https://example.com/${'a'.repeat(600)}`).ok, false);
});

test('detectProvider', () => {
  assert.equal(detectProvider(''), '');
  assert.equal(detectProvider('https://meet.google.com/abc'), 'Google Meet');
  assert.equal(detectProvider('https://us02web.zoom.us/j/1'), 'Zoom');
  assert.equal(detectProvider('https://zoom.us/j/1'), 'Zoom');
  assert.equal(detectProvider('https://evilzoom.us.example.com/j/1'), 'Other');
  assert.equal(detectProvider('https://teams.microsoft.com/l/x'), 'Other');
});

// ── Client status (FR-11) ───────────────────────────────────────────────────
test('deriveClientStatus', () => {
  const sched = { status: 'Scheduled', scheduledAt: '2026-11-02T10:00:00Z' };
  const done = { status: 'Completed', scheduledAt: '2026-10-01T10:00:00Z' };
  assert.equal(deriveClientStatus({ status: 'New' }, []), 'New');
  assert.equal(deriveClientStatus({ status: 'Contacted' }, []), 'Contacted');
  assert.equal(deriveClientStatus({ status: 'Qualified' }, []), 'Contacted');
  assert.equal(deriveClientStatus({ status: 'Contacted' }, [sched]), 'Consultation Scheduled');
  assert.equal(deriveClientStatus({ status: 'Contacted' }, [done]), 'Follow-up Required');
  assert.equal(deriveClientStatus({ status: 'Follow-up' }, []), 'Follow-up Required');
  assert.equal(deriveClientStatus({ status: 'Pending Lost Approval' }, []), 'Follow-up Required');
  assert.equal(deriveClientStatus({ status: 'Converted' }, [sched]), 'Appointment Confirmed');
  assert.equal(deriveClientStatus({ status: 'Lost' }, [sched]), 'Cancelled');
  // A cancelled consultation alone does not make the lead "scheduled".
  assert.equal(deriveClientStatus({ status: 'New' }, [{ status: 'Cancelled' }]), 'New');
});

// ── History ─────────────────────────────────────────────────────────────────
test('historyEntry records who and what, trims the reason', () => {
  const u = user('stylist', ['consultations']);
  const e = historyEntry({ action: 'Cancelled', status: 'Cancelled', user: u, reason: '  bride unwell ' });
  assert.equal(e.by, u._id);
  assert.equal(e.byName, 'U');
  assert.equal(e.reason, 'bride unwell');
  assert.equal(e.overrodeConflict, false);
  assert.ok(e.at instanceof Date);
});

// ── Model (validation + derived fields run without a database) ──────────────
test('generateConsultationNo format', () => {
  assert.match(generateConsultationNo(), /^CN-\d{6}-\d{4}$/);
});

test('Consultation model derives endsAt and a number on validate', async () => {
  const c = new Consultation({
    leadId: id(),
    stylistId: id(),
    scheduledAt: new Date('2026-11-02T04:30:00Z'),
    durationMins: 60,
  });
  await c.validate();
  assert.equal(c.endsAt.toISOString(), '2026-11-02T05:30:00.000Z');
  assert.match(c.consultationNo, /^CN-\d{6}-\d{4}$/);
  assert.equal(c.status, 'Scheduled');
  assert.equal(c.mode, 'Video');
});

test('Consultation model rejects bad enums and missing required fields', async () => {
  const bad = new Consultation({ status: 'Weird', mode: 'Phone' });
  await assert.rejects(() => bad.validate());
  const err = bad.validateSync();
  // leadId is optional now: a Nizan client's calls have no CRM lead.
  assert.equal(err.errors.leadId, undefined);
  assert.ok(err.errors.stylistId);
  assert.ok(err.errors.status);
  assert.ok(err.errors.mode);
});

// ── Reminders ───────────────────────────────────────────────────────────────
const HOUR = 3600000;
const at = (base, ms) => new Date(base.getTime() + ms);

test('dueReminderKey: 1h inside the last hour, 24h inside the last day, else null', () => {
  const now = new Date('2026-11-02T04:00:00Z');
  assert.equal(dueReminderKey(at(now, 30 * 60000), now), '1h');
  assert.equal(dueReminderKey(at(now, HOUR), now), '1h'); // boundary belongs to 1h
  assert.equal(dueReminderKey(at(now, HOUR + 1), now), '24h');
  assert.equal(dueReminderKey(at(now, 24 * HOUR), now), '24h');
  assert.equal(dueReminderKey(at(now, 24 * HOUR + 1), now), null);
  assert.equal(dueReminderKey(now, now), null); // already started
  assert.equal(dueReminderKey(at(now, -HOUR), now), null);
});

test('tiersUpTo retires earlier reminders when a later one is claimed', () => {
  assert.deepEqual(tiersUpTo('24h'), ['24h']);
  assert.deepEqual(tiersUpTo('1h'), ['24h', '1h']);
  assert.deepEqual(tiersUpTo('nope'), []);
});

test('initialRemindersSent: a slot booked inside a window skips that reminder', () => {
  const now = new Date('2026-11-02T04:00:00Z');
  assert.deepEqual(initialRemindersSent(at(now, 3 * 24 * HOUR), now), []);
  assert.deepEqual(initialRemindersSent(at(now, 5 * HOUR), now), ['24h']);
  assert.deepEqual(initialRemindersSent(at(now, 30 * 60000), now), ['24h', '1h']);
});

// ── Notification wording ────────────────────────────────────────────────────
test('describeSlot uses IST and says today / tomorrow / the date', () => {
  // 2026-11-02 04:30Z = 10:00 AM IST
  const now = new Date('2026-11-02T03:00:00Z'); // 8:30 AM IST, 2 Nov
  assert.equal(describeSlot(new Date('2026-11-02T04:30:00Z'), now), 'today at 10:00 AM');
  assert.equal(describeSlot(new Date('2026-11-03T09:30:00Z'), now), 'tomorrow at 3:00 PM');
  assert.equal(describeSlot(new Date('2026-11-09T06:30:00Z'), now), 'on 9 Nov at 12:00 PM');
  // 20:00Z on the 2nd is 1:30 AM IST on the 3rd → "tomorrow", not "today".
  assert.equal(describeSlot(new Date('2026-11-02T20:00:00Z'), now), 'tomorrow at 1:30 AM');
});

test('buildConsultationNotice wording per kind', () => {
  const now = new Date('2026-11-02T03:00:00Z');
  const base = { clientName: 'Anjali', scheduledAt: new Date('2026-11-02T04:30:00Z'), now };
  assert.deepEqual(buildConsultationNotice('assigned', { ...base, actorName: 'Meera' }), {
    title: 'New consultation assigned',
    body: 'Consultation with Anjali today at 10:00 AM, booked by Meera.',
  });
  assert.equal(buildConsultationNotice('rescheduled', base).body, 'Consultation with Anjali is now today at 10:00 AM.');
  assert.equal(
    buildConsultationNotice('cancelled', { ...base, actorName: 'Meera' }).body,
    'Consultation with Anjali (today at 10:00 AM) was cancelled by Meera.'
  );
  assert.match(buildConsultationNotice('reassigned', { ...base, toStylistName: 'Riya' }).body, /moved to Riya/);
  assert.equal(
    buildConsultationNotice('reminder-1h', { ...base, isVideo: true }).body,
    'Consultation with Anjali today at 10:00 AM (video call).'
  );
  assert.equal(buildConsultationNotice('reminder-24h', base).title, 'Upcoming consultation');
  assert.equal(buildConsultationNotice('reminder-1h', base).title, 'Consultation starting soon');
  // Missing client name falls back to wording that still reads.
  assert.match(buildConsultationNotice('assigned', { scheduledAt: base.scheduledAt, now }).body, /with a client/);
});

// ── Reporting ───────────────────────────────────────────────────────────────
import {
  DERIVED_STATUSES,
  countByStatus,
  countDerivedStatuses,
  needingOutcome,
  perStylistBreakdown,
} from '../utils/consultationRules.js';

test('countByStatus tallies every status and the total', () => {
  const rows = [
    { status: 'Scheduled' },
    { status: 'Completed' },
    { status: 'Completed' },
    { status: 'Cancelled' },
    { status: 'No-show' },
  ];
  assert.deepEqual(countByStatus(rows), {
    total: 5,
    Scheduled: 1,
    Completed: 2,
    Cancelled: 1,
    'No-show': 1,
  });
  assert.equal(countByStatus([]).total, 0);
});

test('perStylistBreakdown groups, rates attendance and sorts by completed', () => {
  const a = id();
  const b = id();
  const rows = [
    { stylistId: a, status: 'Completed' },
    { stylistId: a, status: 'Completed' },
    { stylistId: a, status: 'No-show' },
    { stylistId: a, status: 'Cancelled' },
    { stylistId: b, status: 'Scheduled' },
    { stylistId: { _id: b, name: 'Ignored' }, status: 'Completed' },
  ];
  const out = perStylistBreakdown(rows, new Map([[String(a), 'Asha'], [String(b), 'Bina']]));
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Asha');
  assert.deepEqual(
    [out[0].total, out[0].completed, out[0].noShow, out[0].cancelled, out[0].scheduled],
    [4, 2, 1, 1, 0]
  );
  assert.ok(Math.abs(out[0].attendedRate - 2 / 3) < 1e-9);
  // Populated and plain ids for the same stylist land in one row.
  assert.deepEqual([out[1].name, out[1].total, out[1].completed, out[1].scheduled], ['Bina', 2, 1, 1]);
  assert.equal(out[1].attendedRate, 1);
});

test('perStylistBreakdown: no finished consultations → null rate; empty input', () => {
  const out = perStylistBreakdown([{ stylistId: id(), status: 'Scheduled' }]);
  assert.equal(out[0].attendedRate, null);
  assert.deepEqual(perStylistBreakdown([]), []);
});

test('countDerivedStatuses lists every status and uses the lead consultations', () => {
  const l1 = { _id: id(), status: 'New' };
  const l2 = { _id: id(), status: 'Contacted' };
  const l3 = { _id: id(), status: 'Converted' };
  const l4 = { _id: id(), status: 'Lost' };
  const byLead = new Map([[String(l2._id), [{ status: 'Scheduled', scheduledAt: '2026-11-02T10:00:00Z' }]]]);
  const out = countDerivedStatuses([l1, l2, l3, l4], byLead);
  assert.deepEqual(Object.keys(out), DERIVED_STATUSES);
  assert.deepEqual(out, {
    New: 1,
    Contacted: 0,
    'Consultation Scheduled': 1,
    'Follow-up Required': 0,
    'Appointment Confirmed': 1,
    Cancelled: 1,
  });
  assert.equal(Object.values(countDerivedStatuses([], new Map())).every((n) => n === 0), true);
});

test('needingOutcome: only Scheduled consultations that have already ended', () => {
  const now = new Date('2026-11-02T10:00:00Z');
  const mk = (status, startHoursAgo, mins = 45) => {
    const start = new Date(now.getTime() - startHoursAgo * 3600000);
    return { status, scheduledAt: start, endsAt: new Date(start.getTime() + mins * 60000) };
  };
  const out = needingOutcome(
    [mk('Scheduled', 1), mk('Scheduled', 5), mk('Completed', 5), mk('Scheduled', 0.5), mk('Scheduled', -2)],
    now
  );
  // 1h ago ended 15 min ago ✓; 5h ago ✓; 30 min ago still running ✗; future ✗; completed ✗.
  assert.equal(out.length, 2);
  assert.ok(out[0].scheduledAt < out[1].scheduledAt); // oldest first
});

// ── Input limits ────────────────────────────────────────────────────────────
import { TEXT_LIMITS, firstInvalidTextField, parseStatusFilter } from '../utils/consultationRules.js';

test('firstInvalidTextField flags non-strings and over-long values only', () => {
  assert.equal(firstInvalidTextField({}), null);
  assert.equal(firstInvalidTextField(undefined), null);
  assert.equal(firstInvalidTextField({ notes: null, reason: undefined }), null);
  assert.equal(firstInvalidTextField({ notes: 'x'.repeat(TEXT_LIMITS.notes) }), null);
  assert.equal(firstInvalidTextField({ notes: 'x'.repeat(TEXT_LIMITS.notes + 1) }).field, 'notes');
  assert.equal(firstInvalidTextField({ reason: { $ne: '' } }).field, 'reason');
  assert.equal(firstInvalidTextField({ location: 5 }).field, 'location');
  assert.equal(firstInvalidTextField({ unrelated: 'x'.repeat(99999) }), null);
  assert.match(firstInvalidTextField({ nextSteps: 'x'.repeat(2001) }).message, /max 2000/);
});

test('parseStatusFilter only accepts the known statuses as plain strings', () => {
  assert.equal(parseStatusFilter('Completed'), 'Completed');
  assert.equal(parseStatusFilter('No-show'), 'No-show');
  assert.equal(parseStatusFilter('completed'), null);
  assert.equal(parseStatusFilter({ $ne: 'Cancelled' }), null);
  assert.equal(parseStatusFilter(['Completed']), null);
  assert.equal(parseStatusFilter(undefined), null);
});
