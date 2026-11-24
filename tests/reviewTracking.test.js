// Review form open / progress tracking, with the Review model stubbed out:
// no database, no network.   node --test tests/reviewTracking.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Review from '../models/Review.js';
import { trackReview, renderForm } from '../controllers/reviewController.js';

const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const stubUpdates = (t, matched = 1) => {
  const calls = [];
  t.mock.method(Review, 'updateOne', async (filter, update) => {
    calls.push({ filter, update });
    return { matchedCount: matched };
  });
  return calls;
};

test('open: sets first-open time once, bumps count, only on pending reviews', async (t) => {
  const calls = stubUpdates(t);
  const res = fakeRes();
  await trackReview({ params: { token: 'abc' }, body: { event: 'open' } }, res);

  assert.equal(res.body.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].filter, { token: 'abc', status: 'pending', openedAt: null });
  assert.ok(calls[0].update.$set.openedAt instanceof Date);
  assert.deepEqual(calls[1].filter, { token: 'abc', status: 'pending' });
  assert.deepEqual(calls[1].update.$inc, { openCount: 1 });
  assert.ok(calls[1].update.$set.lastOpenedAt instanceof Date);
});

test('progress: only moves forward and is clamped to the total', async (t) => {
  const calls = stubUpdates(t);
  const res = fakeRes();
  await trackReview(
    { params: { token: 'abc' }, body: { event: 'progress', answered: 99, total: 12 } },
    res,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].update.$max, { answeredCount: 12 });
  assert.equal(calls[0].update.$set.totalQuestions, 12);

  const calls2 = stubUpdates(t);
  await trackReview(
    { params: { token: 'abc' }, body: { event: 'progress', answered: -4, total: 'x' } },
    fakeRes(),
  );
  assert.deepEqual(calls2[0].update.$max, { answeredCount: 0 });
  assert.equal(calls2[0].update.$set.totalQuestions, undefined);
});

test('unknown event is rejected without touching the database', async (t) => {
  const calls = stubUpdates(t);
  const res = fakeRes();
  await trackReview({ params: { token: 'abc' }, body: { event: 'submit' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('submitted / unknown link reports ok:false', async (t) => {
  stubUpdates(t, 0);
  const res = fakeRes();
  await trackReview({ params: { token: 'gone' }, body: { event: 'progress', answered: 3, total: 12 } }, res);
  assert.equal(res.body.ok, false);
});

test('the form page reports open + progress to the track endpoint', () => {
  const html = renderForm({ token: 'tok123', brideName: 'Anu', teamMembers: [] });
  assert.match(html, /\/api\/reviews\/track\/'\+TOKEN/);
  assert.match(html, /track\('open'\)/);
  assert.match(html, /track\('progress'/);
});
