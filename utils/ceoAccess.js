// What the CEO login may and may not do on the server. Pure — no database — so the rules can be tested without one
// (tests/ceoAccess.test.js). Applied by middleware/ceoGuard.js from `protect`, the one place every staff route passes through.
//
// The CEO sees everything the company runs on, changes nothing, and decides:
//   • reads (GET / HEAD / OPTIONS) are allowed everywhere EXCEPT the pay and bank-detail routes below;
//   • writes are refused everywhere EXCEPT the decisions in WRITE_ALLOW (approve / reject a project proposal, the CEO
//     Decisions log, clearing their own notifications);
//   • on the people list, pay and bank fields are stripped from what is sent back.
// A view-only role cannot be made by hiding buttons — many of these routes have no role check of their own.

export const CEO_ROLE = 'ceo';

export const isCeo = (user) => String(user?.role ?? '').trim().toLowerCase() === CEO_ROLE;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The only things a CEO may change.
const WRITE_ALLOW = [
  // approve / reject a project proposal
  { methods: ['POST'], re: /^\/api\/projects\/[^/]+\/(approve|reject)$/ },
  // the CEO Decisions log (add, update, defer, mark done, delete)
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], re: /^\/api\/(reports|ceo)\/decisions(\/[^/]+)?$/ },
  // read / clear their own notifications
  { methods: ['PATCH'], re: /^\/api\/notifications\/(read-all|clear-all|[^/]+\/(read|clear))$/ },
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
];

// Fields taken out of the people list on its way to the CEO.
export const REDACTED_FIELDS = ['baseSalary', 'allowances', 'deductions', 'hra', 'accountNumber', 'ifscCode', 'upiId', 'panNumber'];
const REDACT_PATHS = [/^\/api\/employees(\/|$)/];

const pathOf = (url) => String(url ?? '').split('?')[0].replace(/\/+$/, '').toLowerCase() || '/';

/**
 * What to do with this request from the CEO.
 * → { ok: true, redact: boolean } or { ok: false, status: 403, code, message }
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
  return { ok: true, redact: SAFE_METHODS.has(m) && REDACT_PATHS.some((re) => re.test(path)) };
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
