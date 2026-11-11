// Pure unit tests: node --test tests/ceoAccess.test.js
// The CEO login sees everything, changes nothing, and decides. These are the rules that make it so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCeo, ceoVerdict, redactPay, REDACTED_FIELDS } from '../utils/ceoAccess.js';
import { applyCeoGuard } from '../middleware/ceoGuard.js';

const verdict = (m, u) => ceoVerdict(m, u);
const refused = (m, u) => !verdict(m, u).ok;
const code = (m, u) => verdict(m, u).code;

test('who is the CEO', () => {
  assert.equal(isCeo({ role: 'ceo' }), true);
  assert.equal(isCeo({ role: ' CEO ' }), true);
  for (const role of ['admin', 'manager', 'accounts', 'finance_head', 'ceo_assistant', '', undefined]) assert.equal(isCeo({ role }), false, String(role));
  assert.equal(isCeo(undefined), false);
});

test('reads are fine almost everywhere — dashboards, reports, projects, people, bookings', () => {
  for (const url of [
    '/api/dashboard/sales?from=2026-11-01&to=2026-11-30',
    '/api/reports/month-end?month=11&year=2026',
    '/api/accounting/dashboard-summary',
    '/api/work-profit?flag=loss',
    '/api/marketing/insights',
    '/api/hr-analytics/summary', // must not be mistaken for /api/hra
    '/api/timebox/attendance-summary',
    '/api/projects',
    '/api/okrs?scope=company',
    '/api/bookings',
    '/api/auth/users', // the list names people on the dashboards
    '/api/ceo/inbox',
  ]) {
    assert.equal(verdict('GET', url).ok, true, url);
  }
  for (const m of ['HEAD', 'OPTIONS', 'get']) assert.equal(verdict(m, '/api/bookings').ok, true, m);
});

test('writes are refused everywhere else, with a code the app can show', () => {
  for (const [m, url] of [
    ['POST', '/api/bookings'],
    ['PUT', '/api/bookings/123'],
    ['PATCH', '/api/bookings/123'],
    ['DELETE', '/api/bookings/123'],
    ['PUT', '/api/collections/123/verify'],
    ['PUT', '/api/admin-expenses/123/verify'], // the CEO does not approve expenses (Accounts does)
    ['PUT', '/api/reports/targets'],
    ['PUT', '/api/reports/department/sales'],
    ['POST', '/api/projects'], // creating a project is not deciding on one
    ['PUT', '/api/projects/123'],
    ['DELETE', '/api/projects/123'],
    ['POST', '/api/projects/123/departments/IT/respond'],
    ['POST', '/api/it-tasks'],
    ['POST', '/api/auth/users'],
    ['PUT', '/api/auth/users/123'],
    ['DELETE', '/api/auth/users/123'],
    ['POST', '/api/approvals/123/approve'], // HR approvals belong to the people who run them
    ['PATCH', '/api/notifications'],
  ]) {
    assert.equal(code(m, url), 'CEO_READ_ONLY', `${m} ${url}`);
  }
});

test('what the CEO may change: decide on proposals, keep the decisions log, clear their notifications', () => {
  for (const [m, url] of [
    ['POST', '/api/projects/abc123/approve'],
    ['POST', '/api/projects/abc123/reject'],
    ['POST', '/api/projects/abc123/approve/'], // a trailing slash
    ['POST', '/api/reports/decisions'],
    ['PUT', '/api/reports/decisions/abc123'],
    ['DELETE', '/api/reports/decisions/abc123'],
    ['PATCH', '/api/reports/decisions/abc123'],
    ['POST', '/api/ceo/decisions'],
    ['PUT', '/api/ceo/decisions/abc123'],
    ['DELETE', '/api/ceo/decisions/abc123'],
    ['PATCH', '/api/ceo/decisions/abc123'],
    ['PATCH', '/api/notifications/read-all'],
    ['PATCH', '/api/notifications/clear-all'],
    ['PATCH', '/api/notifications/abc123/read'],
    ['PATCH', '/api/notifications/abc123/clear'],
    ['POST', '/API/Projects/ABC/Approve?x=1'], // case and query string do not matter
  ]) {
    assert.equal(verdict(m, url).ok, true, `${m} ${url}`);
  }
});

test('the decisions may not be stretched: only those exact routes, only those methods', () => {
  assert.equal(code('GET', '/api/projects/123/approve'), undefined); // a read is simply a read
  assert.equal(code('PUT', '/api/projects/123/approve'), 'CEO_READ_ONLY');
  assert.equal(code('POST', '/api/projects/123/approve/extra'), 'CEO_READ_ONLY');
  assert.equal(code('POST', '/api/projects/approve'), 'CEO_READ_ONLY');
  assert.equal(code('POST', '/api/reports/decisions/123/extra'), 'CEO_READ_ONLY');
  assert.equal(code('POST', '/api/reports/decisionsX'), 'CEO_READ_ONLY');
  assert.equal(code('POST', '/api/notifications/read-all'), 'CEO_READ_ONLY'); // it is a PATCH
});

test('pay, bank details, people\'s documents and the keys to the system are not readable at all', () => {
  for (const url of [
    '/api/salaries',
    '/api/salaries/123',
    '/api/salaries?month=11&year=2026',
    '/api/hra',
    '/api/hra/123',
    '/api/compensation/bands',
    '/api/timebox/payroll-preview',
    '/api/bank-accounts',
    '/api/bank-accounts/123',
    '/api/employee-documents/123',
    '/api/letters',
    '/api/backup/full',
    '/api/roles',
    '/API/Salaries/', // case and a trailing slash do not get round it
  ]) {
    assert.equal(code('GET', url), 'CEO_NO_ACCESS', url);
  }
});

test('every route in server.js that looks like pay, bank or backup is on the deny list', () => {
  // A new salary-ish route that nobody remembered to list here would be open to the CEO: this fails first.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const mounts = [...server.matchAll(/app\.use\('(\/api\/[a-z0-9\-/]+)'/g)].map((m) => m[1]);
  assert.ok(mounts.length > 40, 'found the route mounts');
  const sensitive = mounts.filter((p) => /salar|payroll|\/hra\b|bank|compens|backup|letter|document/.test(p));
  assert.ok(sensitive.includes('/api/salaries') && sensitive.includes('/api/backup'), `looked at the right routes: ${sensitive}`);
  for (const p of sensitive) assert.equal(code('GET', p), 'CEO_NO_ACCESS', `${p} is pay/bank/backup-like but a CEO can read it`);
});

test('the people list is sent without pay and bank fields; nothing else is lost', () => {
  assert.equal(verdict('GET', '/api/employees').redact, true);
  assert.equal(verdict('GET', '/api/employees/123').redact, true);
  assert.equal(verdict('GET', '/api/employeesX').redact, false);
  assert.equal(verdict('GET', '/api/bookings').redact, false);

  const emp = { _id: 'e1', name: 'Amna', role: 'Artist', baseSalary: 40000, allowances: 2000, deductions: 100, hra: 5000, accountNumber: '123', ifscCode: 'X', upiId: 'a@b', panNumber: 'P', joined: new Date(0) };
  const out = redactPay([emp]);
  assert.deepEqual(Object.keys(out[0]).sort(), ['_id', 'joined', 'name', 'role']);
  assert.ok(out[0].joined instanceof Date);
  for (const f of REDACTED_FIELDS) assert.equal(f in out[0], false, f);
  // and the original is untouched
  assert.equal(emp.baseSalary, 40000);
});

test('redaction reaches populated documents, nested objects and Mongoose-style documents', () => {
  const doc = { toJSON: () => ({ _id: 'e2', name: 'Rizan', baseSalary: 1, bank: { accountNumber: '9', branch: 'Calicut' } }) };
  const out = redactPay({ items: [doc], total: 1 });
  assert.deepEqual(out, { items: [{ _id: 'e2', name: 'Rizan', bank: { branch: 'Calicut' } }], total: 1 });
});

// ── the middleware around it ─────────────────────────────────────────────────

const fakeRes = () => {
  const res = { sent: undefined, statusCode: undefined };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.sent = b), res);
  return res;
};
const run = (user, method, originalUrl) => {
  const req = { user, method, originalUrl };
  const res = fakeRes();
  const answered = applyCeoGuard(req, res);
  return { answered, res };
};

test('middleware: anyone but the CEO is left alone', () => {
  for (const role of ['admin', 'manager', 'accounts']) {
    const { answered, res } = run({ role }, 'DELETE', '/api/salaries/1');
    assert.equal(answered, false, role);
    assert.equal(res.statusCode, undefined);
  }
});

test('middleware: the CEO\'s refused request is answered 403 with the code, and goes no further', () => {
  const write = run({ role: 'ceo' }, 'POST', '/api/bookings');
  assert.equal(write.answered, true);
  assert.equal(write.res.statusCode, 403);
  assert.equal(write.res.sent.code, 'CEO_READ_ONLY');
  assert.match(write.res.sent.message, /view-only/);

  const pay = run({ role: 'ceo' }, 'GET', '/api/salaries');
  assert.equal(pay.answered, true);
  assert.equal(pay.res.sent.code, 'CEO_NO_ACCESS');
});

test('middleware: an allowed request passes, and the people list is redacted on the way out', () => {
  const decide = run({ role: 'ceo' }, 'POST', '/api/projects/abc/approve');
  assert.equal(decide.answered, false);

  const people = run({ role: 'ceo' }, 'GET', '/api/employees');
  assert.equal(people.answered, false);
  people.res.json([{ name: 'Amna', baseSalary: 5 }]);
  assert.deepEqual(people.res.sent, [{ name: 'Amna' }]);

  const other = run({ role: 'ceo' }, 'GET', '/api/bookings');
  other.res.json([{ name: 'X', baseSalary: 5 }]);
  assert.deepEqual(other.res.sent, [{ name: 'X', baseSalary: 5 }]); // only the people list is touched
});
