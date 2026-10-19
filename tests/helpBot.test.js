import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadManual, rank, searchAnswer, buildPrompt } from '../services/helpBot.js';

const entries = loadManual();

test('manual ids are unique and entries are well formed', () => {
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of entries) {
    assert.ok(e.title && e.menuPath && e.summary && Array.isArray(e.steps) && e.steps.length, e.id);
  }
});

test('every manual route exists in the Flutter router (when the app is checked out)', (t) => {
  const file = new URL('../../Nizan_crm/lib/core/routing/app_router.dart', import.meta.url);
  if (!existsSync(file)) return t.skip('app_router.dart not found');
  const src = readFileSync(file, 'utf8');
  const missing = [...new Set(entries.flatMap((e) => [e.route, e.gate]).filter(Boolean))]
    .filter((r) => !src.includes(`path: '${r}'`));
  assert.deepEqual(missing, []);
});

test('search finds the right screen', () => {
  assert.equal(rank('how do I set sales targets', entries)[0].id, 'targets');
  assert.equal(rank('apply for leave', entries)[0].id, 'leave');
  assert.equal(rank('send invoice on whatsapp', entries)[0].id, 'whatsapp-sending');
  assert.equal(rank('add a booking', entries)[0].id, 'booking-add');
});

test('answers only use allowed entries', () => {
  const allowed = entries.filter((e) => e.id !== 'targets');
  const out = searchAnswer('set sales targets', allowed);
  assert.ok(!out.links.some((l) => l.id === 'targets'));
  assert.ok(!buildPrompt('set sales targets', allowed).includes('[targets]'));
});

test('unknown question gives a safe message', () => {
  const out = searchAnswer('zzzz qqqq', entries);
  assert.equal(out.links.length, 0);
});
