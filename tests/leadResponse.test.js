// Pure unit tests: node --test tests/leadResponse.test.js
// Speed to lead: working minutes, the first contact, the figures and the waiting alert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { businessMinutes, responseOf, responseStats, responseGroups, shouldAlert, isAutoLead, cleanResponseSettings, median, DEFAULT_RESPONSE_SETTINGS as D } from '../utils/leadResponse.js';

const ist = (s) => new Date(`${s}+05:30`);

test('working minutes: only inside the day\'s working hours (IST)', () => {
  assert.equal(businessMinutes(ist('2026-11-18T10:00:00'), ist('2026-11-18T10:12:00')), 12);
  assert.equal(businessMinutes(ist('2026-11-18T23:00:00'), ist('2026-11-19T09:10:00')), 10, 'a night form called at 9:10 waited 10 minutes');
  assert.equal(businessMinutes(ist('2026-11-18T20:50:00'), ist('2026-11-19T09:05:00')), 15, '10 before closing + 5 after opening');
  assert.equal(businessMinutes(ist('2026-11-18T07:00:00'), ist('2026-11-18T08:59:00')), 0, 'before opening');
  assert.equal(businessMinutes(ist('2026-11-17T09:00:00'), ist('2026-11-19T09:00:00')), 24 * 60, 'two full working days of 12 hours');
  assert.equal(businessMinutes(ist('2026-11-18T10:00:00'), ist('2026-11-18T09:00:00')), 0, 'backwards is 0');
  assert.equal(businessMinutes(ist('2026-11-18T10:00:00'), ist('2026-11-18T11:00:00'), { dayStart: '21:00', dayEnd: '09:00' }), 60, 'a window that makes no sense counts clock minutes');
  assert.equal(businessMinutes(ist('2026-11-18T08:00:00'), ist('2026-11-18T12:00:00'), { dayStart: '10:00', dayEnd: '11:30' }), 90);
});

test('a lead that came in on its own: a form, the website, or (older) a Meta lead', () => {
  assert.equal(isAutoLead({ origin: 'website' }), true);
  assert.equal(isAutoLead({ origin: '', createdByName: 'Meta Lead Ads' }), true);
  assert.equal(isAutoLead({ origin: '', createdByName: 'Arjun' }), false);
});

test('the first contact is the earliest of the stamp and the first logged activity; waiting and not recorded are kept apart', () => {
  const now = ist('2026-11-18T15:00:00');
  const lead = { createdAt: ist('2026-11-18T10:00:00'), status: 'Contacted', firstContactAt: ist('2026-11-18T10:40:00'), firstContactByName: 'Arjun', firstContactVia: 'status' };
  const r = responseOf(lead, { at: ist('2026-11-18T10:08:00'), byName: 'Neha', via: 'call' }, now);
  assert.deepEqual([r.state, r.minutes, r.within, r.firstBy, r.firstVia], ['contacted', 8, true, 'Neha', 'call']);
  const late = responseOf({ ...lead, firstContactAt: ist('2026-11-18T10:40:00') }, null, now);
  assert.deepEqual([late.minutes, late.within], [40, false]);
  const w = responseOf({ createdAt: ist('2026-11-18T14:20:00'), status: 'New' }, null, now);
  assert.deepEqual([w.state, w.waitingMinutes, w.minutes], ['waiting', 40, null]);
  const u = responseOf({ createdAt: ist('2026-11-18T10:00:00'), status: 'Qualified' }, null, now);
  assert.equal(u.state, 'unrecorded', 'moved on with nothing logged: never a guessed time');
  assert.equal(responseOf({ ...lead, firstContactAt: ist('2026-11-18T09:00:00') }, null, now).minutes, 0, 'contact logged before the lead was typed: 0, never negative');
});

test('the figures: median, share inside the target, waiting and late, not recorded', () => {
  const rows = [
    { state: 'contacted', minutes: 5, within: true, assignee: 'Arjun', source: 'Paid Ads' },
    { state: 'contacted', minutes: 9, within: true, assignee: 'Arjun', source: 'Paid Ads' },
    { state: 'contacted', minutes: 40, within: false, assignee: 'Neha', source: 'Website' },
    { state: 'waiting', waitingMinutes: 50, assignee: 'Neha', source: 'Website' },
    { state: 'waiting', waitingMinutes: 3, assignee: 'Unassigned', source: 'Paid Ads' },
    { state: 'unrecorded', assignee: 'Arjun', source: 'Paid Ads' },
  ];
  assert.deepEqual(responseStats(rows), { leads: 6, contacted: 3, medianMinutes: 9, withinPct: 67, waiting: 2, late: 1, unrecorded: 1 });
  assert.deepEqual(responseStats([]), { leads: 0, contacted: 0, medianMinutes: null, withinPct: null, waiting: 0, late: 0, unrecorded: 0 }, 'nothing: no number, never 0');
  assert.deepEqual(responseGroups(rows, (r) => r.assignee).map((g) => [g.key, g.leads, g.medianMinutes]), [['Arjun', 3, 7], ['Neha', 2, 40], ['Unassigned', 1, null]]);
  assert.equal(median([4, 1, 10, 3]), 4, 'even count: the middle two averaged');
});

test('the alert: a lead from a form, still New, waited past the alert time, not alerted before — and the switch', () => {
  const now = ist('2026-11-18T15:00:00');
  const lead = { origin: 'meta_lead_ads', status: 'New', createdAt: ist('2026-11-18T14:25:00') };
  assert.equal(shouldAlert(lead, null, now), true, '35 working minutes > 30');
  assert.equal(shouldAlert({ ...lead, createdAt: ist('2026-11-18T14:35:00') }, null, now), false, '25 minutes: not yet');
  assert.equal(shouldAlert({ ...lead, responseAlertAt: now }, null, now), false, 'once');
  assert.equal(shouldAlert({ ...lead, origin: '' }, null, now), false, 'typed in by staff');
  assert.equal(shouldAlert(lead, { at: ist('2026-11-18T14:30:00') }, now), false, 'already called');
  assert.equal(shouldAlert(lead, null, now, { ...D, alertsOn: false }), false);
  assert.equal(shouldAlert({ ...lead, createdAt: ist('2026-11-18T23:30:00') }, null, ist('2026-11-19T09:20:00')), false, 'a night lead at 9:20: 20 working minutes');
});

test('settings: checked, only what was sent changes', () => {
  assert.deepEqual(cleanResponseSettings({ targetMinutes: '10' }).value, { ...D, targetMinutes: 10 });
  assert.equal(cleanResponseSettings({ targetMinutes: 0 }).ok, false);
  assert.equal(cleanResponseSettings({ dayStart: '9am' }).field, 'dayStart');
  assert.equal(cleanResponseSettings({ dayStart: '21:00', dayEnd: '09:00' }).field, 'dayEnd');
  assert.equal(cleanResponseSettings({ alertsOn: 'no' }).value.alertsOn, false, 'only true is true');
  assert.equal(cleanResponseSettings({ alertAfterMinutes: 3000 }).ok, false);
});
