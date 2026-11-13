// What the LEADERSHIP logins (the CEO and the Executive Director — see utils/leadership.js) may and may not do on the server. Pure —
// no database — so the rules can be tested without one (tests/ceoAccess.test.js). Applied by middleware/ceoGuard.js from `protect`,
// the one place every staff route passes through.
//
// Leadership sees everything the company runs on, changes nothing, and decides:
//   • reads (GET / HEAD / OPTIONS) are allowed everywhere EXCEPT the pay and bank-detail routes below;
//   • writes are refused everywhere EXCEPT the decisions in WRITE_ALLOW (approve / reject a project proposal, the CEO
//     Decisions log, clearing their own notifications);
//   • on the people list, pay and bank fields are stripped from what is sent back.
// A view-only role cannot be made by hiding buttons — many of these routes have no role check of their own.

import { isLeadership } from './leadership.js';
import { SENSITIVE_EMPLOYEE_FIELDS } from './hrAccess.js';

export const CEO_ROLE = 'ceo';

/// Kept under its old name: it now means "a leadership login" (the CEO or the Executive Director).
export const isCeo = isLeadership;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The only things a CEO may change.
const WRITE_ALLOW = [
  // approve / reject a project proposal
  { methods: ['POST'], re: /^\/api\/projects\/[^/]+\/(approve|reject)$/ },
  // the CEO Decisions log (add, update, defer, mark done, delete)
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], re: /^\/api\/(reports|ceo)\/decisions(\/[^/]+)?$/ },
  // read / clear their own notifications
  { methods: ['PATCH'], re: /^\/api\/notifications\/(read-all|clear-all|[^/]+\/(read|clear))$/ },
  // decide on what is waiting for them (approve / reject / defer) and set what reaches them
  { methods: ['POST'], re: /^\/api\/decisions\/[^/]+\/decide$/ },
  { methods: ['PUT'], re: /^\/api\/decision-policy$/ },
];

// Pay, bank details, people's documents and the keys to the system: not even readable. (The user LIST stays readable — the
// dashboards use it to name people — and changing a user is a write, which is refused anyway.) (Totals reach the CEO through
// the dashboards and the month-end review, which only ever add figures up.)
const DENY = [
  /^\/api\/salaries(\/|$)/,
  /^\/api\/hra(\/|$)/,
  /^\/api\/compensation(\/|$)/,
  /^\/api\/timebox\/payroll/,
  /^\/api\/bank-accounts(\/|$)/,
  /^\/api\/employee-documents(\/|$)/,
  /^\/api\/letters(\/|$)/,
  /^\/api\/backup(\/|$)/,
  /^\/api\/roles(\/|$)/,
  // routes that carry pay although their name does not say so (found by looking at what each response holds):
  /^\/api\/audit(\/|$)/, // the audit log keeps every salary change as from → to
  /^\/api\/employees\/[^/]+\/increments(\/|$)/, // previous and new salary
  /^\/api\/accounting\/(journal|ledger)(\/|$)/, // vouchers such as "Salary · <name>" and "HRA · <name>"
  /^\/api\/offboarding\/[^/]+\/settlement(\/|$)/, // base salary and the final settlement
  /^\/api\/recruitment\/offers(\/|$)/, // the salary offered to a candidate
];

// Fields taken out of the people list on its way to the CEO.
// (the one list HR itself uses for "only HR / payroll may read", plus the raise history fields)
export const REDACTED_FIELDS = [...SENSITIVE_EMPLOYEE_FIELDS, 'previousSalary', 'newSalary'];
const REDACT_PATHS = [/^\/api\/employees(\/|$)/];

// Text that names a person's pay on a voucher, a transaction or an expense row ("Salary · Aisha", "HRA - Aisha (11/2026)"): such
// lines are dropped from lists (company and department totals stay).
const SCRUB_PATHS = [/^\/api\/(accounting|cash-transactions|admin-expenses|reports|dashboard)(\/|$)/];
const PAY_TEXT = /^(salary|hra)(\s*[·\-–]\s*).+$/i;

const pathOf = (url) => String(url ?? '').split('?')[0].replace(/\/+$/, '').toLowerCase() || '/';

/**
 * What to do with this request from a leadership login.
 * → { ok: true, redact: boolean, scrub: boolean } or { ok: false, status: 403, code, message }
 */
export const ceoVerdict = (method, url) => {
  const m = String(method ?? 'GET').toUpperCase();
  const path = pathOf(url);

  if (DENY.some((re) => re.test(path))) {
    return { ok: false, status: 403, code: 'CEO_NO_ACCESS', message: 'Pay, bank details and system settings are not part of the CEO login.' };
  }
  if (!SAFE_METHODS.has(m) && !WRITE_ALLOW.some((r) => r.methods.includes(m) && r.re.test(path))) {
    return { ok: false, status: 403, code: 'CEO_READ_ONLY', message: 'This login is view-only. You can decide on proposals and keep the decisions log.' };
  }
  const read = SAFE_METHODS.has(m);
  return { ok: true, redact: read && REDACT_PATHS.some((re) => re.test(path)), scrub: read && SCRUB_PATHS.some((re) => re.test(path)) };
};

/** A copy of [value] without the redacted fields, however deep (arrays, nested objects, populated documents). */
export const redactPay = (value) => {
  if (Array.isArray(value)) return value.map(redactPay);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
    if (plain !== value) return redactPay(plain);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!REDACTED_FIELDS.includes(k)) out[k] = redactPay(v);
    }
    return out;
  }
  return value;
};

const plainOf = (v) => (v && typeof v === 'object' && !(v instanceof Date) && typeof v.toJSON === 'function' ? v.toJSON() : v);

/// Is this list item a line about one person's pay: a bare "Salary · Aisha", or a row with such a text in it (a voucher, a transaction)?
const isPayRow = (item) => {
  const v = plainOf(item);
  if (typeof v === 'string') return PAY_TEXT.test(v);
  if (!v || typeof v !== 'object' || v instanceof Date || Array.isArray(v)) return false;
  return Object.values(v).some((x) => typeof x === 'string' && PAY_TEXT.test(x));
};

/// A copy of [value] without the lines that are one person's pay. In a LIST, a row such as {narration: "Salary · Aisha", amount: 48211}
/// is dropped altogether (the amount alone is her salary, name or no name); a text standing alone, in an object, becomes
/// "Salary · (staff)". Company and department TOTALS are untouched — those are what a leader reads.
export const scrubPayText = (value) => {
  if (typeof value === 'string') {
    const m = PAY_TEXT.exec(value);
    return m ? `${m[1]} · (staff)` : value;
  }
  if (Array.isArray(value)) return value.filter((x) => !isPayRow(x)).map(scrubPayText);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const plain = plainOf(value);
    if (plain !== value) return scrubPayText(plain);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubPayText(v);
    return out;
  }
  return value;
};

// ── every API mount, classified (tests/leadershipMounts.test.js fails when server.js gains a mount that is in neither list, so
// a new route is a deliberate decision, not an oversight) ───────────────────────────────────────────────────────────────────────
// Refused outright (GET included):
export const LEADERSHIP_DENIED_MOUNTS = [
  '/api/salaries', '/api/hra', '/api/compensation', '/api/bank-accounts', '/api/employee-documents', '/api/letters',
  '/api/backup', '/api/roles', '/api/audit',
];

// Readable (the guard still refuses every write except the decisions below, and strips or scrubs pay where a response carries it).
// Some of these have sub-routes on the deny list above: /api/accounting (journal, ledger), /api/employees (increments, and pay
// fields on every record), /api/offboarding (settlement), /api/recruitment (offers), /api/timebox (payroll).
export const LEADERSHIP_READ_OK_MOUNTS = [
  '/api', '/api/account-reports', '/api/accounting', '/api/addon-services', '/api/admin-expenses', '/api/app-clients',
  '/api/approvals', '/api/artist-payouts', '/api/assets', '/api/attendances', '/api/auth', '/api/blocked-dates',
  '/api/booking-advances', '/api/bookings', '/api/budgets', '/api/cash-transactions', '/api/ceo', '/api/chat', '/api/client',
  '/api/client/auth', '/api/collections', '/api/company-reports', '/api/consultations', '/api/content', '/api/customers',
  '/api/dashboard', '/api/decision-policy', '/api/decisions', '/api/departments', '/api/designations', '/api/districts', '/api/employee-assets', '/api/employees',
  '/api/engagement', '/api/enquiry-counts', '/api/expense-categories', '/api/expenses', '/api/fleet',
  '/api/fleet/availability', '/api/fleet/gps-km', '/api/food-allowances', '/api/fuel-expenses', '/api/fuel-prices', '/api/geo',
  '/api/goals', '/api/grievances', '/api/help', '/api/hr', '/api/hr-analytics', '/api/inventory', '/api/it-tasks',
  '/api/leads', '/api/leave', '/api/lms', '/api/manpower', '/api/marketing', '/api/marketing/eod', '/api/monthly-objectives',
  '/api/notifications', '/api/offboarding', '/api/okrs', '/api/onboarding', '/api/packages', '/api/performance',
  '/api/pincodes', '/api/project-docs', '/api/projects', '/api/recruitment', '/api/regions', '/api/regularizations',
  '/api/reimbursements', '/api/reports', '/api/reviews', '/api/sales-reports', '/api/sales-returns', '/api/sales-targets',
  '/api/shifts', '/api/slots', '/api/states', '/api/strategic-vision', '/api/stylist-clients', '/api/subscriptions',
  '/api/tax-filings', '/api/tickets', '/api/time-blocks', '/api/timebox', '/api/timesheets', '/api/travel',
  '/api/trial-packages', '/api/trials', '/api/upload', '/api/vehicles', '/api/whatsapp', '/api/work-profit', '/api/zones',
];
