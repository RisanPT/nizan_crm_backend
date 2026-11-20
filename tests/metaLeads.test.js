// Pure unit tests: node --test tests/metaLeads.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  META_MAX_ATTEMPTS,
  answersOf,
  checkDays,
  classifyGraphError,
  isGraphUrl,
  mapAnswers,
  metaConfig,
  nextTryAt,
  parseFormDate,
  questionLabel,
  readLeadgenChanges,
  remarksFor,
  turnOf,
  usablePhone,
  verifyMetaSignature,
} from '../utils/metaLeads.js';

const sign = (raw, secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
// 18 Nov 2026, 10:00 IST
const NOW = new Date('2026-11-18T04:30:00Z');
const istDay = (d) => (d ? new Date(d.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10) : null);

test('config: ready only with all three settings; never hands out an unknown version', () => {
  assert.equal(metaConfig({}).ready, false);
  assert.equal(metaConfig({ META_APP_SECRET: 's', META_ACCESS_TOKEN: 't' }).ready, false);
  const c = metaConfig({ META_APP_SECRET: 's', META_ACCESS_TOKEN: 't', META_WEBHOOK_VERIFY_TOKEN: 'v', META_GRAPH_VERSION: 'v26.0', META_PAGE_IDS: '123, abc ,456' });
  assert.equal(c.ready, true);
  assert.equal(c.version, 'v26.0');
  assert.deepEqual(c.pageIds, ['123', '456']);
  assert.deepEqual(c.has, { appSecret: true, token: true, verifyToken: true });
  assert.equal(metaConfig({ META_GRAPH_VERSION: '26' }).version, 'v25.0');
  assert.equal(metaConfig({ META_GRAPH_VERSION: 'v25.0/../me' }).version, 'v25.0');
});

test('signature: only the app secret over the exact bytes passes', () => {
  const raw = Buffer.from('{"object":"page"}');
  assert.equal(verifyMetaSignature(raw, sign(raw, 'secret'), 'secret'), true);
  assert.equal(verifyMetaSignature(raw, sign(raw, 'other'), 'secret'), false);
  assert.equal(verifyMetaSignature(Buffer.from('{"object":"page" }'), sign(raw, 'secret'), 'secret'), false);
  assert.equal(verifyMetaSignature(raw, sign(raw, 'secret').replace('sha256=', 'sha1='), 'secret'), false);
  assert.equal(verifyMetaSignature(raw, '', 'secret'), false);
  assert.equal(verifyMetaSignature(raw, sign(raw, ''), ''), false); // no secret set: nothing passes
  assert.equal(verifyMetaSignature('{"object":"page"}', sign(raw, 'secret'), 'secret'), false); // a parsed body is not the raw bytes
});

test('webhook body: leadgen changes only, each lead once, ids must be numbers', () => {
  const body = {
    object: 'page',
    entry: [
      { id: '111', time: 1, changes: [
        { field: 'leadgen', value: { leadgen_id: '9001', page_id: '111', form_id: '77', ad_id: '55', adgroup_id: '44', created_time: 1794990000 } },
        { field: 'feed', value: { post_id: '1' } },
        { field: 'leadgen', value: { leadgen_id: '9001', page_id: '111' } },
      ] },
      { id: '222', changes: [{ field: 'leadgen', value: { leadgen_id: '9002', form_id: 'x' } }, { field: 'leadgen', value: { leadgen_id: '../me' } }] },
    ],
  };
  const out = readLeadgenChanges(body);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { leadgenId: '9001', pageId: '111', formId: '77', adId: '55', adsetId: '44', createdTime: new Date(1794990000 * 1000) });
  assert.equal(out[1].pageId, '222'); // from the entry when the change has none
  assert.equal(out[1].formId, '');
  assert.deepEqual(readLeadgenChanges({ object: 'user', entry: body.entry }), []);
  assert.deepEqual(readLeadgenChanges(null), []);
});

test('answers: names lower-cased, several values joined, empty answers dropped', () => {
  const a = answersOf([{ name: 'Full_Name', values: [' Asha '] }, { name: 'services', values: ['Bridal', 'Party'] }, { name: 'note', values: [''] }, { values: ['x'] }]);
  assert.deepEqual(a, [{ key: 'full_name', value: 'Asha' }, { key: 'services', value: 'Bridal, Party' }]);
  assert.equal(questionLabel('when_is_your_wedding?'), 'When is your wedding');
});

test('mapping: Meta standard questions fill the lead; our own questions by their words; the rest goes to the remarks', () => {
  const m = mapAnswers(
    answersOf([
      { name: 'full_name', values: ['Asha Nair'] },
      { name: 'phone_number', values: ['+91 98470 12345'] },
      { name: 'email', values: ['asha@example.com'] },
      { name: 'whatsapp_number', values: ['+919847099999'] },
      { name: 'zip_code', values: ['673 001'] },
      { name: 'city', values: ['Kozhikode'] },
      { name: 'event_type', values: ['Wedding'] },
      { name: 'when_is_your_wedding?', values: ['15/12/2026'] },
      { name: 'budget_range', values: ['50k-1L'] },
    ]),
    NOW,
  );
  assert.equal(m.name, 'Asha Nair');
  assert.equal(m.phone, '+919847012345');
  assert.equal(m.whatsapp, '+919847099999');
  assert.equal(m.email, 'asha@example.com');
  assert.equal(m.pincode, '673001');
  assert.equal(m.location, 'Kozhikode');
  assert.equal(m.eventType, 'Wedding');
  assert.equal(istDay(m.probableDate), '2026-12-15');
  assert.deepEqual(m.extra, [{ key: 'budget_range', label: 'Budget range', value: '50k-1L' }]);
});

test('mapping: first + last name; an unreadable date and a bad pincode stay in the remarks; a foreign country is kept', () => {
  const m = mapAnswers(
    answersOf([
      { name: 'first_name', values: ['Fathima'] },
      { name: 'last_name', values: ['K'] },
      { name: 'phone', values: ['0501234567'] },
      { name: 'wedding_date', values: ['sometime next year'] },
      { name: 'post_code', values: ['12345'] },
      { name: 'city', values: ['Dubai'] },
      { name: 'country', values: ['AE'] },
    ]),
    NOW,
  );
  assert.equal(m.name, 'Fathima K');
  assert.equal(m.probableDate, null);
  assert.equal(m.pincode, '');
  assert.equal(m.location, 'Dubai, AE');
  assert.ok(m.extra.some((x) => x.key === 'wedding_date' && x.value === 'sometime next year'));
  assert.ok(m.extra.some((x) => x.key === 'post_code' && x.value === '12345'));
  assert.equal(m.extra.some((x) => x.key === 'country'), false);
});

test('dates: Indian day-first, ISO, month names; no year = the next one; past or far-off dates are not guessed', () => {
  const d = (s) => istDay(parseFormDate(s, NOW));
  assert.equal(d('15/12/2026'), '2026-12-15');
  assert.equal(d('15-12-26'), '2026-12-15');
  assert.equal(d('15.12.2026'), '2026-12-15');
  assert.equal(d('2026-12-15'), '2026-12-15');
  assert.equal(d('2026-12-15T00:00:00+0530'), '2026-12-15');
  assert.equal(d('15th December 2026'), '2026-12-15');
  assert.equal(d('Dec 15, 2026'), '2026-12-15');
  assert.equal(d('20 Jan'), '2027-01-20'); // already past this year → next year
  assert.equal(d('25 Nov'), '2026-11-25');
  assert.equal(d('18/11/2026'), '2026-11-18'); // today counts
  assert.equal(d('17/11/2026'), null); // yesterday
  assert.equal(d('12/25/2026'), null); // US order: month 25 does not exist
  assert.equal(d('31/02/2027'), null);
  assert.equal(d('01/01/2031'), null); // over 3 years away
  assert.equal(d('next month'), null);
  assert.equal(d(''), null);
  // stored as IST midnight, the way the app saves a date-only value
  assert.equal(parseFormDate('15/12/2026', NOW).toISOString(), '2026-12-14T18:30:00.000Z');
});

test('phone: at least 8 digits', () => {
  assert.equal(usablePhone('+91 98470 12345'), true);
  assert.equal(usablePhone('12345'), false);
  assert.equal(usablePhone(''), false);
});

test('remarks: where she came from first, then the unused answers', () => {
  const r = remarksFor({ formName: 'Bridal Nov', adName: 'Reel 17', campaignName: 'Kerala Nov', platform: 'ig', extra: [{ label: 'Budget range', value: '50k' }], notes: ['E-mail: x@'] });
  assert.equal(r, 'Meta Lead Ads on Instagram · form "Bridal Nov" · ad "Reel 17" · campaign "Kerala Nov"\nBudget range: 50k\nE-mail: x@');
  assert.equal(remarksFor({ isOrganic: true, platform: 'fb' }), 'Meta form (no ad) on Facebook');
});

test('Graph errors: the plain reason and whether to try again', () => {
  assert.equal(classifyGraphError(400, { error: { code: 190, message: 'Error validating access token' } }).code, 'token');
  assert.equal(classifyGraphError(400, { error: { code: 100, error_subcode: 33 } }).code, 'missing');
  assert.equal(classifyGraphError(400, { error: { code: 100, error_subcode: 33 } }).retry, false);
  assert.equal(classifyGraphError(400, { error: { code: 200 } }).code, 'permission');
  assert.equal(classifyGraphError(403, {}).code, 'permission');
  assert.equal(classifyGraphError(400, { error: { code: 17 } }).code, 'rate_limit');
  assert.equal(classifyGraphError(429, null).code, 'rate_limit');
  assert.equal(classifyGraphError(503, null).code, 'meta_down');
  assert.equal(classifyGraphError(400, { error: { code: 1 } }).code, 'meta_down');
  const other = classifyGraphError(400, { error: { code: 803, message: 'Some aliases do not exist' } });
  assert.equal(other.code, 'refused');
  assert.match(other.text, /Some aliases do not exist/);
});

test('retries: 5, 10, 20 … minutes, capped at 6 hours, never past the last try or for a lost cause', () => {
  const at = (n) => (nextTryAt(n, NOW) ? (nextTryAt(n, NOW) - NOW) / 60000 : null);
  assert.equal(at(1), 5);
  assert.equal(at(2), 10);
  assert.equal(at(3), 20);
  assert.equal(at(META_MAX_ATTEMPTS - 1), 80);
  assert.equal(at(META_MAX_ATTEMPTS), null);
  assert.equal(nextTryAt(1, NOW, false), null);
  assert.equal(Math.min(5 * 2 ** 20, 360), 360); // the cap the rule uses
});

test('taking turns: in order, round and round; nobody → null', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => turnOf(ids, n)), ['a', 'b', 'c', 'a', 'b']);
  assert.equal(turnOf([], 1), null);
});

test('check window and next-page links', () => {
  assert.equal(checkDays(undefined), 7);
  assert.equal(checkDays(90), 90);
  assert.equal(checkDays(91), null);
  assert.equal(checkDays(0), null);
  assert.equal(checkDays('3'), 3);
  assert.equal(checkDays(1.5), null);
  assert.equal(isGraphUrl('https://graph.facebook.com/v25.0/1/leads?after=x'), true);
  assert.equal(isGraphUrl('http://graph.facebook.com/v25.0/1/leads'), false);
  assert.equal(isGraphUrl('https://graph.facebook.com.evil.example/x'), false);
  assert.equal(isGraphUrl('not a url'), false);
});
