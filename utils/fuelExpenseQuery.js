// Reads and validates the filters of the fleet-expense list (Accounts → Fleet
// Expenses). Pure — tests/fuelExpenseQuery.test.js. The database half (turning the
// parsed filters into a Mongo query, incl. the text search) is in
// services/fuelExpenseQuery.js.
//
// Query string (all optional):
//   from, to        'YYYY-MM-DD' (IST, inclusive) — the expense date
//   status          pending | approved | rejected   (comma list)
//   category        fuel | food | toll | parking | service | other | outsource_salary   (comma list)
//   paymentMode     cash | upi | card | credit | other   (comma list)
//   driverId, vehicleId   ids
//   bill            with | without      (has a bill photo or not)
//   work            linked | whole_day  (tied to one work, or filed under the whole day)
//   minAmount, maxAmount
//   search          free text: driver, vehicle, station, notes, client, booking number, amount
//   sort            date_desc (default) | date_asc | amount_desc | amount_asc

import { isDay } from './istDate.js';

export const STATUSES = ['pending', 'approved', 'rejected'];
export const CATEGORIES = ['fuel', 'food', 'toll', 'parking', 'service', 'other', 'outsource_salary'];
export const PAYMENT_MODES = ['cash', 'upi', 'card', 'credit', 'other'];
export const SORTS = {
  date_desc: { date: -1, createdAt: -1 },
  date_asc: { date: 1, createdAt: 1 },
  amount_desc: { totalAmount: -1, date: -1 },
  amount_asc: { totalAmount: 1, date: -1 },
};

export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const OBJECT_ID = /^[a-f\d]{24}$/i;

/// 'a, b' → ['a','b'] (lower-case, unique); a value outside `allowed` is a 400.
export const list = (raw, allowed, label) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  const out = [];
  for (const part of String(raw).split(',')) {
    const v = part.trim().toLowerCase();
    if (!v) continue;
    if (!allowed.includes(v)) throw new QueryError(`Unknown ${label} "${v}".`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
};

export const id = (raw, label) => {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  if (!OBJECT_ID.test(v)) throw new QueryError(`Invalid ${label}.`);
  return v;
};

export const day = (raw, label) => {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  if (!isDay(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) throw new QueryError(`${label} must be a date like 2026-10-31.`);
  return v;
};

export const amount = (raw, label) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0) throw new QueryError(`${label} must be a number, 0 or more.`);
  return n;
};

/// Escapes text so it matches literally inside a regular expression.
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {object} q  req.query
 * @returns {{ from, to, statuses, categories, paymentModes, driverId, vehicleId, bill, work,
 *             minAmount, maxAmount, search, sort }}
 * @throws {QueryError} (status 400) for a malformed value
 */
export const parseExpenseQuery = (q = {}) => {
  const from = day(q.from, 'From date');
  const to = day(q.to, 'To date');
  if (from && to && from > to) throw new QueryError('The "from" date is after the "to" date.');

  const bill = String(q.bill ?? '').trim().toLowerCase();
  if (bill && !['with', 'without'].includes(bill)) throw new QueryError('bill must be "with" or "without".');
  const work = String(q.work ?? '').trim().toLowerCase();
  if (work && !['linked', 'whole_day'].includes(work)) throw new QueryError('work must be "linked" or "whole_day".');

  const sort = String(q.sort ?? '').trim().toLowerCase() || 'date_desc';
  if (!(sort in SORTS)) throw new QueryError(`Unknown sort "${sort}".`);

  const minAmount = amount(q.minAmount, 'Minimum amount');
  const maxAmount = amount(q.maxAmount, 'Maximum amount');
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    throw new QueryError('The minimum amount is more than the maximum.');
  }

  return {
    from,
    to,
    statuses: list(q.status, STATUSES, 'status'),
    categories: list(q.category, CATEGORIES, 'category'),
    paymentModes: list(q.paymentMode, PAYMENT_MODES, 'payment mode'),
    driverId: id(q.driverId, 'driver'),
    vehicleId: id(q.vehicleId, 'vehicle'),
    bill,
    work,
    minAmount,
    maxAmount,
    search: String(q.search ?? '').trim().slice(0, 80),
    sort,
  };
};
