// Pure unit tests: node --test tests/metaCapi.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CAPI_LEAD_EVENT_SOURCE,
  capiConfig,
  capiEvent,
  capiNextTry,
  normEmail,
  normPhone,
  requestBody,
  stageTime,
  stageTimes,
  stagesFor,
  tooOld,
} from '../utils/metaCapi.js';

const NOW = new Date('2026-11-18T10:00:00Z');
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');

test('config: a dataset and a token; an Events Manager token goes without our proof, ours with it', () => {
  assert.equal(capiConfig({}).ready, false);
  assert.equal(capiConfig({ META_CAPI_DATASET_ID: '123', META_ACCESS_TOKEN: 't' }).ready, false, 'our token needs our app secret');
  const ours = capiConfig({ META_CAPI_DATASET_ID: '123', META_ACCESS_TOKEN: 't', META_APP_SECRET: 's' });
  assert.deepEqual([ours.ready, ours.proof, ours.token], [true, true, 't']);
  const em = capiConfig({ META_CAPI_DATASET_ID: '123', META_CAPI_TOKEN: 'capi', META_ACCESS_TOKEN: 't' });
  assert.deepEqual([em.ready, em.proof, em.token, em.has.ownToken], [true, false, 'capi', true]);
  assert.equal(capiConfig({ META_CAPI_DATASET_ID: 'pixel-1', META_CAPI_TOKEN: 'x' }).ready, false, 'a dataset id is digits');
  assert.equal(capiConfig({ META_CAPI_DATASET_ID: '1', META_CAPI_TOKEN: 'x', META_CAPI_TEST_CODE: 'TEST123' }).has.testMode, true);
});

test('stages: what each CRM status has reached (a booking means contacted and qualified too)', () => {
  assert.deepEqual(stagesFor('New'), ['Lead']);
  assert.deepEqual(stagesFor('Contacted'), ['Lead', 'Contacted']);
  assert.deepEqual(stagesFor('Qualified'), ['Lead', 'Contacted', 'Qualified']);
  assert.deepEqual(stagesFor('Follow-up'), ['Lead', 'Contacted', 'Follow-up']);
  assert.deepEqual(stagesFor('Pending Lost Approval'), ['Lead'], 'not decided yet');
  assert.deepEqual(stagesFor('Lost'), ['Lead', 'Lost']);
  assert.deepEqual(stagesFor('Converted'), ['Lead', 'Contacted', 'Qualified', 'Converted']);
  assert.deepEqual(stagesFor('Follow-up', { booked: true }), ['Lead', 'Contacted', 'Qualified', 'Converted'], 'a booking is a booking');
  assert.deepEqual(stagesFor(undefined), ['Lead']);
});

test('times: the form for Lead, the booking for Converted, the last change otherwise — never before the form, never ahead', () => {
  const t = { submittedAt: '2026-11-15T10:00:00Z', bookedAt: '2026-11-17T09:00:00Z', updatedAt: '2026-11-17T12:00:00Z' };
  const s = (d) => Math.floor(Date.parse(d) / 1000);
  assert.equal(stageTime('Lead', t, NOW), s(t.submittedAt));
  assert.equal(stageTime('Converted', t, NOW), s(t.bookedAt));
  assert.equal(stageTime('Contacted', t, NOW), s(t.updatedAt));
  assert.equal(stageTime('Contacted', { ...t, updatedAt: '2026-11-14T00:00:00Z' }, NOW), s(t.submittedAt) + 1, 'just after the form');
  assert.equal(stageTime('Qualified', { ...t, updatedAt: '2026-11-20T00:00:00Z' }, NOW), s(NOW.toISOString()), 'not in the future');
  assert.equal(stageTime('Converted', { submittedAt: t.submittedAt, updatedAt: t.updatedAt }, NOW), s(t.updatedAt), 'no booking time: the last change');
});

test('stages in funnel order are never dated after a later one (inferred stages take the later time)', () => {
  const s = (d) => Math.floor(Date.parse(d) / 1000);
  const t = { submittedAt: '2026-11-15T10:00:00Z', bookedAt: '2026-11-17T09:00:00Z', updatedAt: '2026-11-17T12:00:00Z' };
  assert.deepEqual(stageTimes(['Lead', 'Contacted', 'Qualified', 'Converted'], t, NOW), [s(t.submittedAt), s(t.bookedAt), s(t.bookedAt), s(t.bookedAt)]);
  assert.deepEqual(stageTimes(['Lead', 'Lost'], t, NOW), [s(t.submittedAt), s(t.updatedAt)]);
});

test('Meta takes 7 days back (an hour kept for the send)', () => {
  const s = (d) => Math.floor(Date.parse(d) / 1000);
  assert.equal(tooOld(s('2026-11-12T10:00:00Z'), NOW), false);
  assert.equal(tooOld(s('2026-11-11T11:30:00Z'), NOW), false, 'just inside');
  assert.equal(tooOld(s('2026-11-11T10:30:00Z'), NOW), true, 'inside the hour kept for the send');
  assert.equal(tooOld(s('2026-11-11T08:00:00Z'), NOW), true);
});

test('customer details normalised as Meta matches them', () => {
  assert.equal(normEmail('  Asha@Example.COM '), 'asha@example.com');
  assert.equal(normEmail('not an email'), '');
  assert.equal(normPhone('+91 98470 12345'), '919847012345');
  assert.equal(normPhone('98470 12345'), '919847012345', 'an Indian mobile without its code');
  assert.equal(normPhone('098470-12345'), '919847012345');
  assert.equal(normPhone('0091 9847012345'), '919847012345');
  assert.equal(normPhone('+971 50 123 4567'), '971501234567', 'a foreign number keeps its own code');
  assert.equal(normPhone('12345'), '');
});

test('an event: the stage, Unix seconds, system_generated, the lead id NOT hashed, e-mail and phone hashed, crm source', () => {
  const e = capiEvent({ stage: 'Converted', eventTime: 1795000000, leadgenId: '12345678901234567', email: 'Asha@example.com', phone: '+91 98470 12345' });
  assert.deepEqual(e, {
    event_name: 'Converted',
    event_time: 1795000000,
    action_source: 'system_generated',
    user_data: { lead_id: '12345678901234567', em: [hash('asha@example.com')], ph: [hash('919847012345')] },
    custom_data: { event_source: 'crm', lead_event_source: CAPI_LEAD_EVENT_SOURCE },
  });
  assert.deepEqual(capiEvent({ stage: 'Lead', eventTime: 1, leadgenId: '9', email: 'x', phone: '1' }).user_data, { lead_id: '9' }, 'nothing unusable is sent');
});

test('the body writes each 17-digit lead id as an exact number; the test code only when set', () => {
  const body = requestBody([capiEvent({ stage: 'Lead', eventTime: 1, leadgenId: '12345678901234567' })]);
  assert.match(body, /"lead_id":12345678901234567[,}]/);
  assert.equal(body.includes('"12345678901234567"'), false);
  assert.equal(JSON.parse(body).data[0].event_name, 'Lead');
  assert.equal(body.includes('test_event_code'), false);
  assert.equal(JSON.parse(requestBody([], 'TEST1')).test_event_code, 'TEST1');
  assert.equal(String(JSON.parse(body).data[0].user_data.lead_id).length > 0, true);
});

test('retries: 10, 20, 40 … minutes, capped at 6 hours, never past the last try or for a lost cause', () => {
  const at = (n) => (capiNextTry(n, NOW) ? (capiNextTry(n, NOW) - NOW) / 60000 : null);
  assert.deepEqual([at(1), at(2), at(3), at(5)], [10, 20, 40, 160]);
  assert.equal(at(6), null);
  assert.equal(capiNextTry(1, NOW, false), null);
});
