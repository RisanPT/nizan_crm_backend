// Pure unit tests: node --test tests/ceoAccess.test.js
// The CEO login sees everything, changes nothing, and decides. These are the rules that make it so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCeo, ceoVerdict, redactPay, scrubPayText, REDACTED_FIELDS } from '../utils/ceoAccess.js';
import { SENSITIVE_EMPLOYEE_FIELDS } from '../utils/hrAccess.js';
import { applyCeoGuard } from '../middleware/ceoGuard.js';

const verdict = (m, u) => ceoVerdict(m, u);
const refused = (m, u) => !verdict(m, u).ok;
const code = (m, u) => verdict(m, u).code;

test('who is the CEO (and the Executive Director, who has the same login rules)', () => {
  assert.equal(isCeo({ role: 'ceo' }), true);
  assert.equal(isCeo({ role: ' CEO ' }), true);
  assert.equal(isCeo({ role: 'executive_director' }), true);
  assert.equal(isCeo({ role: ' Executive_Director ' }), true);
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

// ── the Executive Director gets exactly the CEO's rules ──────────────────────

const LEADERS = ['ceo', 'executive_director'];

test('middleware: the Executive Director is refused and redacted just like the CEO', () => {
  for (const role of LEADERS) {
    const write = run({ role }, 'POST', '/api/bookings');
    assert.equal(write.answered, true, role);
    assert.equal(write.res.sent.code, 'CEO_READ_ONLY', role);
    assert.equal(run({ role }, 'GET', '/api/salaries').res.sent.code, 'CEO_NO_ACCESS', role);
    assert.equal(run({ role }, 'POST', '/api/projects/abc/approve').answered, false, role);
    assert.equal(run({ role }, 'PUT', '/api/admin-expenses/1/verify').res.sent.code, 'CEO_READ_ONLY', role);
    const people = run({ role }, 'GET', '/api/employees');
    people.res.json([{ name: 'Amna', baseSalary: 5, bankName: 'ZZ', overtimeRate: 3, dateOfBirth: 'x' }]);
    assert.deepEqual(people.res.sent, [{ name: 'Amna' }], role);
  }
});

// ── routes that carry pay although their name does not say so ────────────────

test('the audit log, raise history, ledger vouchers, settlements and offers are not readable (they hold people\'s pay)', () => {
  for (const url of [
    '/api/audit',
    '/api/audit?entity=Salary',
    '/api/audit/employee/123',
    '/api/employees/123/increments',
    '/api/employees/123/increments/',
    '/api/accounting/journal',
    '/api/accounting/journal?from=2026-11-01',
    '/api/accounting/ledger/123',
    '/api/offboarding/123/settlement',
    '/api/recruitment/offers',
    '/api/recruitment/offers/123',
    '/API/Audit/', // case and a trailing slash do not get round it
  ]) {
    assert.equal(code('GET', url), 'CEO_NO_ACCESS', url);
  }
});

test('…while their neighbours stay readable — the dashboards, customers, the exit list, hiring plans, one person\'s record', () => {
  for (const url of [
    '/api/accounting/dashboard-summary',
    '/api/accounting/party-statement',
    '/api/accounting/transactions',
    '/api/employees',
    '/api/employees/123',
    '/api/employees/123/reporting',
    '/api/offboarding',
    '/api/offboarding/123',
    '/api/recruitment/plans',
    '/api/recruitment/jobs',
    '/api/auditx',
  ]) {
    assert.equal(verdict('GET', url).ok, true, url);
  }
});

test('the redacted fields are the one list HR uses for "only HR / payroll may read", plus the raise history', () => {
  for (const f of SENSITIVE_EMPLOYEE_FIELDS) assert.ok(REDACTED_FIELDS.includes(f), f);
  assert.ok(REDACTED_FIELDS.includes('previousSalary'));
  assert.ok(REDACTED_FIELDS.includes('newSalary'));
  assert.equal(REDACTED_FIELDS.length, SENSITIVE_EMPLOYEE_FIELDS.length + 2);
  const out = redactPay([{ _id: 'i1', employeeId: 'e1', previousSalary: 30000, newSalary: 35000, bankName: 'ZZ', note: 'annual' }]);
  assert.deepEqual(out, [{ _id: 'i1', employeeId: 'e1', note: 'annual' }]);
});

// ── pay lines on the accounts ────────────────────────────────────────────────

test('a text standing alone that names a person\'s pay reads "Salary · (staff)"', () => {
  assert.equal(scrubPayText('Salary · Aisha'), 'Salary · (staff)');
  assert.equal(scrubPayText('HRA · Aisha K'), 'HRA · (staff)');
  assert.equal(scrubPayText('Salary - Aisha (11/2026)'), 'Salary · (staff)');
  assert.equal(scrubPayText('hra – bob'), 'hra · (staff)');
  assert.equal(scrubPayText('SALARY · X'), 'SALARY · (staff)');
  assert.deepEqual(scrubPayText({ title: 'HRA - Bob (1/2026)', note: 'ok' }), { title: 'HRA · (staff)', note: 'ok' });
});

test('in a LIST, a row that is one person\'s pay is dropped altogether — its amount alone would be her salary', () => {
  const rows = [
    { voucherNo: 'JV1', narration: 'Salary · Aisha', amount: 48211.55 },
    { voucherNo: 'JV2', narration: 'Studio rent', amount: 9000 },
    { voucherNo: 'JV3', narration: 'HRA - Bob (1/2026)', amount: 5000 },
  ];
  assert.deepEqual(scrubPayText(rows), [{ voucherNo: 'JV2', narration: 'Studio rent', amount: 9000 }]);
  assert.deepEqual(scrubPayText({ unusual: rows, total: 62211.55 }), { unusual: [{ voucherNo: 'JV2', narration: 'Studio rent', amount: 9000 }], total: 62211.55 });
  assert.deepEqual(scrubPayText(['Salary · Aisha', 'Office rent']), ['Office rent'], 'a bare list of narrations too');
  assert.deepEqual(scrubPayText({ a: [{ lines: [{ narration: 'Salary · Z', debit: 1 }, { narration: 'Rent', debit: 2 }] }] }), { a: [{ lines: [{ narration: 'Rent', debit: 2 }] }] }, 'however deep');
});

test('…and nothing else is: other text, numbers, dates, nulls, totals, and the word salary elsewhere in a sentence', () => {
  const when = new Date(0);
  for (const v of ['Office rent', 'Salary', 'Salary advance policy', 'Monthly salary · note', '', 'Hrafn', 5, null, true]) assert.equal(scrubPayText(v), v, String(v));
  assert.equal(scrubPayText(undefined), undefined);
  assert.equal(scrubPayText(when), when);
  assert.deepEqual(scrubPayText({ payroll: { total: 58211.65, byDepartment: [{ name: 'Sales', total: 58211.65 }] } }), { payroll: { total: 58211.65, byDepartment: [{ name: 'Sales', total: 58211.65 }] } });
  const doc = { toJSON: () => ({ narration: 'Salary · Aisha', n: 1 }) };
  assert.deepEqual(scrubPayText({ rows: [doc, { narration: 'Rent' }] }), { rows: [{ narration: 'Rent' }] });
});

test('the accounts, cash, expense, report and dashboard reads are scrubbed; nothing else is touched', () => {
  for (const url of ['/api/accounting/transactions', '/api/cash-transactions', '/api/admin-expenses', '/api/reports/month-end', '/api/dashboard/finance']) {
    assert.equal(verdict('GET', url).scrub, true, url);
  }
  for (const url of ['/api/bookings', '/api/employees', '/api/projects', '/api/leads', '/api/accountingX']) {
    assert.equal(verdict('GET', url).scrub, false, url);
  }
});

test('middleware: a leader\'s accounts response loses the lines about people\'s pay (the totals stay)', () => {
  for (const role of LEADERS) {
    const r = run({ role }, 'GET', '/api/accounting/transactions');
    assert.equal(r.answered, false);
    r.res.json({ total: 13000, rows: [{ narration: 'Salary · Aisha', amount: 4000 }, { narration: 'Studio rent', amount: 9000 }] });
    assert.deepEqual(r.res.sent, { total: 13000, rows: [{ narration: 'Studio rent', amount: 9000 }] }, role);
  }
});

test('middleware: other people get the accounts untouched', () => {
  const r = run({ role: 'accounts' }, 'GET', '/api/accounting/transactions');
  assert.equal(r.answered, false);
  r.res.json([{ narration: 'Salary · Aisha' }]);
  assert.deepEqual(r.res.sent, [{ narration: 'Salary · Aisha' }]);
});

// ── the decision desk: what the leaders may change, and nothing else ─────────

test('leaders may decide on a request and set the decision rules — and write nothing else under those paths', () => {
  assert.equal(ceoVerdict('POST', '/api/decisions/64b2f0c1a1b2c3d4e5f60718/decide').ok, true);
  assert.equal(ceoVerdict('PUT', '/api/decision-policy').ok, true);
  assert.equal(ceoVerdict('GET', '/api/decisions/queue?scope=open').ok, true);
  assert.equal(ceoVerdict('GET', '/api/decision-policy').ok, true);
  for (const [m, p] of [
    ['DELETE', '/api/decisions/64b2f0c1a1b2c3d4e5f60718'],
    ['PUT', '/api/decisions/64b2f0c1a1b2c3d4e5f60718'],
    ['POST', '/api/decisions/64b2f0c1a1b2c3d4e5f60718'],
    ['POST', '/api/decisions/64b2f0c1a1b2c3d4e5f60718/decide/extra'],
    ['POST', '/api/decisions/queue'],
    ['POST', '/api/decision-policy'],
    ['DELETE', '/api/decision-policy'],
    ['PUT', '/api/decision-policy/x'],
  ]) {
    const v = ceoVerdict(m, p);
    assert.equal(v.ok, false, `${m} ${p}`);
    assert.equal(v.code, 'CEO_READ_ONLY', `${m} ${p}`);
  }
});
