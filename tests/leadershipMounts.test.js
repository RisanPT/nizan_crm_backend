// Pure unit tests: node --test tests/leadershipMounts.test.js
// FAIL-CLOSED: every API mount in server.js must be classified for the leadership logins (CEO, Executive Director) as either
// "readable" or "denied". A new mount with no classification fails here, so a route that carries pay or bank data cannot be added
// without somebody deciding what the leaders may see. (The old test only matched mount NAMES like salary/bank, and so missed
// /api/audit, raise history and ledger vouchers.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ceoVerdict, LEADERSHIP_DENIED_MOUNTS, LEADERSHIP_READ_OK_MOUNTS } from '../utils/ceoAccess.js';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const mounts = [...new Set([...server.matchAll(/app\.use\('(\/api[a-z0-9\-/]*)'/g)].map((m) => m[1]))];

test('server.js has the mounts we think it has', () => {
  assert.ok(mounts.length > 90, `found ${mounts.length} mounts`);
  for (const m of ['/api/salaries', '/api/audit', '/api/ceo', '/api/projects', '/api/accounting']) assert.ok(mounts.includes(m), m);
});

test('every mount is classified — a new one must be added to LEADERSHIP_READ_OK_MOUNTS or LEADERSHIP_DENIED_MOUNTS on purpose', () => {
  const known = new Set([...LEADERSHIP_DENIED_MOUNTS, ...LEADERSHIP_READ_OK_MOUNTS]);
  const unclassified = mounts.filter((m) => !known.has(m));
  assert.deepEqual(unclassified, [], `Decide what the CEO / Executive Director may do with: ${unclassified.join(', ')}`);
});

test('the manifest names no mount that no longer exists, and no mount twice', () => {
  const all = [...LEADERSHIP_DENIED_MOUNTS, ...LEADERSHIP_READ_OK_MOUNTS];
  assert.equal(new Set(all).size, all.length, 'a mount is listed twice');
  const gone = all.filter((m) => !mounts.includes(m));
  assert.deepEqual(gone, [], `listed but not mounted: ${gone.join(', ')}`);
  for (const m of LEADERSHIP_DENIED_MOUNTS) assert.ok(!LEADERSHIP_READ_OK_MOUNTS.includes(m), `${m} is in both lists`);
});

test('every denied mount really is refused to a GET, with and without a sub-path', () => {
  for (const m of LEADERSHIP_DENIED_MOUNTS) {
    for (const url of [m, `${m}/123`, `${m}?x=1`]) {
      const v = ceoVerdict('GET', url);
      assert.equal(v.ok, false, url);
      assert.equal(v.code, 'CEO_NO_ACCESS', url);
    }
  }
});

test('every readable mount is readable (the manifest and the guard agree)', () => {
  for (const m of LEADERSHIP_READ_OK_MOUNTS) assert.equal(ceoVerdict('GET', m).ok, true, m);
});

test('anything that looks like pay, bank, backup or secrets in its NAME is denied (the old rule, kept as a second net)', () => {
  const sensitive = mounts.filter((p) => /salar|payroll|\/hra\b|bank|compens|backup|letter|document|audit/.test(p));
  assert.ok(sensitive.includes('/api/salaries') && sensitive.includes('/api/backup') && sensitive.includes('/api/audit'), String(sensitive));
  for (const p of sensitive) assert.equal(ceoVerdict('GET', p).code, 'CEO_NO_ACCESS', `${p} looks like pay/bank/backup/audit but a leader can read it`);
});
