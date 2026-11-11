import mongoose from 'mongoose';
import Collection from '../models/Collection.js';
import Expense from '../models/Expense.js';
import Booking from '../models/Booking.js';
import Trial from '../models/Trial.js';
import Employee from '../models/Employee.js';
import { istStart, istEnd } from '../utils/istDate.js';
import { parseFinanceQuery, sortFor, escapeRegex } from '../utils/financeListQuery.js';

// The database half of the Accounts lists of artist COLLECTIONS and artist EXPENSES
// (parsing / validation: utils/financeListQuery.js). The list, its totals and the
// export all go through the same filter, so they always agree on what "the
// filtered entries" are.

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const NO_ONE = '000000000000000000000000';
const EXPORT_CAP = 5000;

const KINDS = {
  collection: { Model: Collection, attachment: 'attachmentUrl' },
  expense: { Model: Expense, attachment: 'receiptImage' },
};

/**
 * @param {object} p   from parseFinanceQuery
 * @param {object} [o]
 * @param {boolean} [o.excludeStatus]     ignore the status filter (for the status chips' counts)
 * @param {*} [o.scopeEmployeeId]        an artist / driver signed in sees only their own — wins over employeeId
 * @returns a Mongo filter. Ids are real ObjectIds because aggregate() does not cast.
 */
export const buildFinanceFilter = async (p, { excludeStatus = false, scopeEmployeeId = null } = {}) => {
  const { attachment } = KINDS[p.kind];
  const f = {};
  const and = [];

  if (p.from || p.to) {
    f.date = {};
    if (p.from) f.date.$gte = istStart(p.from);
    if (p.to) f.date.$lte = istEnd(p.to);
  }
  if (!excludeStatus && p.statuses.length) f.status = { $in: p.statuses };
  if (p.employeeId) f.employeeId = oid(p.employeeId);
  if (p.paymentModes.length) f.paymentMode = { $in: p.paymentModes };
  if (p.categories.length) f.category = { $in: p.categories };
  if (p.workType) f.workType = p.workType;
  if (p.ocr.length) f.ocrStatus = { $in: p.ocr };

  if (p.link === 'booking') f.bookingId = { $ne: null };
  if (p.link === 'trial') f.trialId = { $ne: null };
  if (p.link === 'none') {
    f.bookingId = null; // matches "no booking" and "field missing"
    if (p.kind === 'collection') f.trialId = null;
  }

  if (p.bill === 'with') f[attachment] = { $nin: ['', null] };
  if (p.bill === 'without') and.push({ $or: [{ [attachment]: '' }, { [attachment]: null }] });

  if (p.minAmount !== null || p.maxAmount !== null) {
    f.amount = {};
    if (p.minAmount !== null) f.amount.$gte = p.minAmount;
    if (p.maxAmount !== null) f.amount.$lte = p.maxAmount;
  }

  if (p.search) {
    const rx = new RegExp(escapeRegex(p.search), 'i');
    const [artists, bookings, trials] = await Promise.all([
      Employee.find({ name: rx }).select('_id').limit(200).lean(),
      // client name / service / booking number → the entries tied to those bookings
      Booking.find({ $or: [{ customerName: rx }, { bookingNumber: rx }, { service: rx }] }).select('_id').limit(500).lean(),
      p.kind === 'collection'
        ? Trial.find({ $or: [{ clientName: rx }, { trialNumber: rx }] }).select('_id').limit(500).lean()
        : Promise.resolve([]),
    ]);
    const ors = [{ notes: rx }];
    if (p.kind === 'expense') ors.push({ category: rx });
    if (artists.length) ors.push({ employeeId: { $in: artists.map((a) => a._id) } });
    if (bookings.length) ors.push({ bookingId: { $in: bookings.map((b) => b._id) } });
    if (trials.length) ors.push({ trialId: { $in: trials.map((t) => t._id) } });
    if (/^\d+(\.\d+)?$/.test(p.search)) ors.push({ amount: Number(p.search) });
    and.push({ $or: ors });
  }

  if (scopeEmployeeId) f.employeeId = oid(scopeEmployeeId);
  if (and.length) f.$and = and;
  return f;
};

const groupBy = (Model, match, field) =>
  Model.aggregate([
    { $match: match },
    { $group: { _id: `$${field}`, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    { $sort: { amount: -1 } },
  ]);

/**
 * Totals for the WHOLE filtered set (every page):
 *   byStatus   per-status count + amount, IGNORING the status filter (chips / cards)
 *   shown      count + amount of exactly what the list shows
 *   byMode     collections: per payment mode          byCategory / byWorkType  expenses
 *   byArtist   top 8 artists by amount, with names
 */
export const summarizeFinance = async (p, opts = {}) => {
  const { Model } = KINDS[p.kind];
  const full = await buildFinanceFilter(p, opts);
  const noStatus = await buildFinanceFilter(p, { ...opts, excludeStatus: true });

  const [statusRows, shownRows, modeRows, categoryRows, workRows, artistRows] = await Promise.all([
    groupBy(Model, noStatus, 'status'),
    Model.aggregate([{ $match: full }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    p.kind === 'collection' ? groupBy(Model, full, 'paymentMode') : [],
    p.kind === 'expense' ? groupBy(Model, full, 'category') : [],
    p.kind === 'expense' ? groupBy(Model, full, 'workType') : [],
    Model.aggregate([
      { $match: full },
      { $group: { _id: '$employeeId', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      { $sort: { amount: -1 } },
      { $limit: 8 },
    ]),
  ]);

  const names = new Map(
    (await Employee.find({ _id: { $in: artistRows.map((r) => r._id) } }).select('name').lean()).map((e) => [String(e._id), e.name]),
  );
  const status = Object.fromEntries(['pending', 'verified', 'rejected'].map((s) => [s, { count: 0, amount: 0 }]));
  for (const r of statusRows) if (r._id in status) status[r._id] = { count: r.count, amount: round2(r.amount) };
  const rows = (list, key) => list.map((r) => ({ [key]: r._id, count: r.count, amount: round2(r.amount) }));

  return {
    byStatus: status,
    shown: { count: shownRows[0]?.count ?? 0, amount: round2(shownRows[0]?.amount) },
    byMode: rows(modeRows, 'mode'),
    byCategory: rows(categoryRows, 'category'),
    byWorkType: rows(workRows, 'workType'),
    byArtist: artistRows.map((r) => ({ employeeId: String(r._id), name: names.get(String(r._id)) ?? 'Artist', count: r.count, amount: round2(r.amount) })),
  };
};

/**
 * One call for both lists. Returns { body } to send, or throws a QueryError (400).
 *   ?page= / ?limit=   a page: { items, page, limit, totalItems, totalPages }
 *   ?summary=1         (with a page) adds the whole-set totals
 *   ?export=1          every match (capped): { items, totalItems, truncated }
 *   otherwise          the plain array
 * An artist / driver signed in only ever gets their own entries.
 */
export const runFinanceList = async ({ kind, query, user, populate }) => {
  const parsed = parseFinanceQuery(query, kind);
  const { Model } = KINDS[kind];
  const owner = user && (user.role === 'artist' || user.role === 'driver');
  // (a user with no linked employee matches nothing rather than everything)
  const scope = { scopeEmployeeId: owner ? user.employeeId || NO_ONE : null };
  const filter = await buildFinanceFilter(parsed, scope);
  const sort = sortFor(parsed.sort);

  if (query.export === '1') {
    const [items, totalItems] = await Promise.all([
      Model.find(filter).populate(populate).sort(sort).limit(EXPORT_CAP),
      Model.countDocuments(filter),
    ]);
    return { items, totalItems, truncated: totalItems > EXPORT_CAP };
  }

  const page = Number.parseInt(query.page, 10);
  const limit = Number.parseInt(query.limit, 10);
  if (Number.isFinite(page) || Number.isFinite(limit)) {
    const currentPage = Math.max(1, page || 1);
    const currentLimit = Math.min(100, Math.max(1, limit || 20));
    const [items, totalItems, summary] = await Promise.all([
      Model.find(filter).populate(populate).sort(sort).skip((currentPage - 1) * currentLimit).limit(currentLimit),
      Model.countDocuments(filter),
      query.summary === '1' ? summarizeFinance(parsed, scope) : null,
    ]);
    return {
      items,
      page: currentPage,
      limit: currentLimit,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      ...(summary ? { summary } : {}),
    };
  }

  return Model.find(filter).populate(populate).sort(sort);
};
