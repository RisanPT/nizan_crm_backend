// Reads and validates the filters of the Accounts lists of artist COLLECTIONS and
// artist EXPENSES (Artist Finance, Finance & Invoices). Pure —
// tests/financeListQuery.test.js. The database half (the Mongo filter, the text
// search and the totals) is in services/financeList.js.
//
// Query string (all optional; the page is added with ?page=&limit=):
//   from, to        'YYYY-MM-DD' (IST, inclusive) — the entry's date
//   status          pending | verified | rejected   (comma list)
//   employeeId      the artist
//   paymentMode     collections: cash | upi | bank_transfer | other   (comma list)
//   category        expenses: food | travel | stay | materials | fuel | other (comma list)
//   workType        expenses: bridal | model_shoot
//   bill            with | without   (has a screenshot / receipt photo or not)
//   link            collections: booking | trial | none     expenses: booking | none
//   ocr             match | mismatch | skipped | pending   (the screenshot check; comma list)
//   minAmount, maxAmount
//   search          free text: client, service, booking / trial number, artist, notes, amount
//   sort            date_desc (default) | date_asc | amount_desc | amount_asc

import { QueryError, escapeRegex, list, id, day, amount } from './fuelExpenseQuery.js';

export { QueryError, escapeRegex };

export const FINANCE_KINDS = ['collection', 'expense'];
export const FINANCE_STATUSES = ['pending', 'verified', 'rejected'];
export const COLLECTION_MODES = ['cash', 'upi', 'bank_transfer', 'other'];
export const EXPENSE_CATEGORIES = ['food', 'travel', 'stay', 'materials', 'fuel', 'other'];
export const WORK_TYPES = ['bridal', 'model_shoot'];
export const OCR_STATUSES = ['match', 'mismatch', 'skipped', 'pending'];
export const LINKS = { collection: ['booking', 'trial', 'none'], expense: ['booking', 'none'] };

const SORTS = {
  date_desc: { date: -1, createdAt: -1 },
  date_asc: { date: 1, createdAt: 1 },
  amount_desc: { amount: -1, date: -1 },
  amount_asc: { amount: 1, date: -1 },
};

export const sortFor = (sort) => SORTS[sort] ?? SORTS.date_desc;

/// These only exist on the list the app now calls. A request carrying none of them
/// is an older caller and keeps the plain, unfiltered-by-the-new-rules behaviour.
const NEW_KEYS = ['page', 'limit', 'export', 'summary', 'search', 'sort', 'from', 'to', 'minAmount', 'maxAmount', 'bill', 'link', 'ocr', 'category'];
export const isNewStyleQuery = (q = {}) => NEW_KEYS.some((k) => q[k] !== undefined && q[k] !== '');

/**
 * @param {object} q     req.query
 * @param {'collection'|'expense'} kind
 * @throws {QueryError} (status 400) for a malformed value
 */
export const parseFinanceQuery = (q = {}, kind = 'collection') => {
  if (!FINANCE_KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
  const from = day(q.from, 'From date');
  const to = day(q.to, 'To date');
  if (from && to && from > to) throw new QueryError('The "from" date is after the "to" date.');

  const bill = String(q.bill ?? '').trim().toLowerCase();
  if (bill && !['with', 'without'].includes(bill)) throw new QueryError('bill must be "with" or "without".');

  const link = String(q.link ?? '').trim().toLowerCase();
  if (link && !LINKS[kind].includes(link)) throw new QueryError(`link must be one of: ${LINKS[kind].join(', ')}.`);

  const workType = String(q.workType ?? '').trim().toLowerCase();
  if (workType && workType !== 'all' && !WORK_TYPES.includes(workType)) throw new QueryError('workType must be "bridal" or "model_shoot".');

  const sort = String(q.sort ?? '').trim().toLowerCase() || 'date_desc';
  if (!(sort in SORTS)) throw new QueryError(`Unknown sort "${sort}".`);

  const minAmount = amount(q.minAmount, 'Minimum amount');
  const maxAmount = amount(q.maxAmount, 'Maximum amount');
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) throw new QueryError('The minimum amount is more than the maximum.');

  return {
    kind,
    from,
    to,
    statuses: list(q.status, FINANCE_STATUSES, 'status'),
    employeeId: id(q.employeeId, 'artist'),
    // each only means something on its own kind
    paymentModes: kind === 'collection' ? list(q.paymentMode, COLLECTION_MODES, 'payment mode') : [],
    categories: kind === 'expense' ? list(q.category, EXPENSE_CATEGORIES, 'category') : [],
    workType: kind === 'expense' && workType !== 'all' ? workType : '',
    bill,
    link,
    ocr: list(q.ocr, OCR_STATUSES, 'screenshot check'),
    minAmount,
    maxAmount,
    search: String(q.search ?? '').trim().slice(0, 80),
    sort,
  };
};
