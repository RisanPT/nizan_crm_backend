import asyncHandler from 'express-async-handler';
import Employee from '../models/Employee.js';
import Booking from '../models/Booking.js';
import ArtistPayout from '../models/ArtistPayout.js';
import { addDays, istEnd, istStart, parseDayParam, todayIst } from '../utils/istDate.js';
import { LEADERSHIP_ROLES } from '../utils/leadership.js';
import { hasModule, isFullAccess } from '../utils/hrAccess.js';
import * as W from '../utils/associateWorks.js';
import { CRM_HEAD_ROLE } from '../utils/crmAccess.js';

// ASSOCIATE ARTISTS — outside artists who work a bride's event as associates. Operations adds them while assigning a work's team; Accounts
// pays them per work through Artist Payouts (the freelancer flow); this report joins the two. The rules are in utils/associateWorks.js.
//
//   POST /api/employees/associates   quick-add (or find) an associate while assigning a work          (routes/employeeRoutes.js)
//   GET  /api/associate-works        the Associate Works report                                       (routes/associateWorksRoutes.js)

const MAX_DAYS = 366;
const EXPORT_CAP = 2000;
const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

const roleOf = (u) => String(u?.role ?? '').trim().toLowerCase();

// Who sees the works at all, and who also sees the money. The CRM (Operations) team that assigns associates sees the works, not what they
// are paid — that is Accounts' and the owners'. (Leadership is read-only: middleware/ceoGuard.js.)
const FEE_ROLES = new Set(['accounts', 'finance_head', 'admin', 'manager', 'artist_head', ...LEADERSHIP_ROLES]);
const WORK_ROLES = new Set([...FEE_ROLES, 'crm', CRM_HEAD_ROLE]);
const canSeeFees = (u) => FEE_ROLES.has(roleOf(u)) || u?.artistHead === true || (Array.isArray(u?.permissions) && u.permissions.some((p) => p === 'payables' || p.startsWith('payables.')));
const canSeeWorks = (u) => WORK_ROLES.has(roleOf(u)) || canSeeFees(u);

/** Phone digits only, so "90000 00001" and "9000000001" are the same number. */
const digits = (v) => String(v ?? '').replace(/\D/g, '');

const thisMonth = () => {
  const [y, m] = todayIst().split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return [`${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2, '0')}`];
};

/**
 * Find the associate with this phone number, or create one. Shared by the quick-add and the temporary-staff conversion.
 * @returns {{ employee, existing: boolean } | { conflict: Employee }}  conflict = the number belongs to someone on the team who is NOT an associate
 */
export const findOrCreateAssociate = async ({ name, phone = '', specialization = '' }) => {
  const d = digits(phone);
  if (d.length >= 7) {
    // the same number typed another way ("90000 00001", "+91 90000-00001") is the same person
    const tail = d.slice(-10).split('').join('[\\s-]*');
    const clash = await Employee.findOne({ phone: new RegExp(`${tail}$`) }).lean();
    if (clash) return clash.isAssociate === true ? { employee: clash, existing: true } : { conflict: clash };
  }
  const employee = await Employee.create({
    name,
    phone: String(phone).replace(/\s+/g, ''),
    specialization,
    works: specialization ? [specialization] : [],
    type: 'outsource',
    isAssociate: true,
    artistRole: 'assistant',
    salaryType: 'per_booking',
    category: 'operations',
    department: 'Operations',
    status: 'active',
  });
  return { employee: employee.toObject(), existing: false };
};

// @desc   Add an associate while assigning a work — or find the one that is already there (same phone number).
//         Body { name, phone?, specialization? }. Creates an outsource artist with no login and no payroll.
// @route  POST /api/employees/associates
// @access Private — whoever works with bookings (admin / manager / CRM / artist head / sales / accounts…)
// @returns 201 { employee, existing: false } · 200 { employee, existing: true } when that number is already an associate
export const addAssociate = asyncHandler(async (req, res) => {
  const u = req.user;
  if (!(isFullAccess(u) || hasModule(u, 'bookings'))) bad(res, 'You are not allowed to add an associate.', 403);
  const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) bad(res, 'Give the associate\'s name (2 to 80 letters).');
  const phone = String(req.body?.phone ?? '').trim();
  const d = digits(phone);
  if (phone && (d.length < 7 || d.length > 15)) bad(res, 'The phone number does not look right.');
  const specialization = String(req.body?.specialization ?? '').trim().slice(0, 60);

  const made = await findOrCreateAssociate({ name, phone, specialization });
  if (made.conflict) bad(res, `This number already belongs to ${made.conflict.name}, who is on the team — pick them from the staff list instead.`, 409);
  res.status(made.existing ? 200 : 201).json({ employee: made.employee, existing: made.existing });
});

const PICK = 'bookingNumber customerName service status serviceStart selectedDates district region assignedStaff bookingItems.service bookingItems.selectedDates bookingItems.assignedStaff';

// @desc   The Associate Works report: which works each associate did in a period, with the fee Accounts recorded for each.
//         ?from= &to= (IST days; default this month, at most a year) &associateId= &payout=paid|owed|none &search=
//         ?page= &limit= (a page of works) or ?export=1 (every work; capped)
// @route  GET /api/associate-works
// @access Private — works: admin / manager / CRM / artist head / accounts / finance head / leadership; money: all of those but CRM
// @returns { from, to, canSeeFees, summary, associates, items, page, limit, totalItems, totalPages, truncated, elsewhere, registered }
//          summary + associates cover every work in the period matching the search; items are cut by associate and payout too.
export const getAssociateWorks = asyncHandler(async (req, res) => {
  if (!canSeeWorks(req.user)) bad(res, 'Not authorized', 403);
  const fees = canSeeFees(req.user);
  const [monthFrom, monthTo] = thisMonth();
  const from = req.query.from ? parseDayParam(req.query.from) : monthFrom;
  const to = req.query.to ? parseDayParam(req.query.to) : monthTo;
  if (!from || !to) bad(res, 'from / to must be days (YYYY-MM-DD)');
  if (from > to) bad(res, 'The "from" day is after the "to" day.');
  if (addDays(from, MAX_DAYS) < to) bad(res, 'Choose a period of a year or less.');
  const payout = String(req.query.payout ?? '');
  if (payout && !W.PAYOUT_FILTERS.includes(payout)) bad(res, 'payout must be paid, owed or none');
  const associateId = String(req.query.associateId ?? '');
  if (associateId && !/^[0-9a-f]{24}$/i.test(associateId)) bad(res, 'associateId is not valid');
  const q = String(req.query.search ?? '').trim().slice(0, 80);

  const associates = await Employee.find({ isAssociate: true }).select('name phone status').lean();
  const ids = associates.map((a) => a._id);
  const people = associates.map((a) => ({ id: String(a._id), name: a.name, phone: a.phone }));
  let bookings = [];
  let payouts = [];
  if (ids.length) {
    bookings = await Booking.find({
      serviceStart: { $gte: istStart(from), $lte: istEnd(to) },
      $or: [{ 'assignedStaff.employeeId': { $in: ids } }, { 'bookingItems.assignedStaff.employeeId': { $in: ids } }],
    })
      .select(PICK)
      .lean();
    if (fees) {
      payouts = await ArtistPayout.find({ employeeId: { $in: ids }, status: { $ne: 'cancelled' }, $or: [{ bookingId: { $in: bookings.map((b) => b._id) } }, { date: { $gte: istStart(from), $lte: istEnd(to) } }] })
        .select('employeeId bookingId amount status date')
        .lean();
    }
  }

  const all = W.searchRows(W.workRows({ bookings, associates: people, payouts, canSeeFees: fees }), q);
  const shown = W.sortRows(W.filterRows(all, { associateId, payout: fees ? payout : '' }));
  const base = {
    from,
    to,
    canSeeFees: fees,
    summary: W.summarize(all),
    associates: W.byAssociate(all),
    elsewhere: fees ? W.elsewhere({ payouts: payouts.filter((p) => p.date >= istStart(from) && p.date <= istEnd(to)), rows: all }) : null,
    registered: associates.length,
  };
  if (req.query.export === '1') return res.json({ ...base, items: shown.slice(0, EXPORT_CAP), totalItems: shown.length, truncated: shown.length > EXPORT_CAP });
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  res.json({ ...base, items: shown.slice((page - 1) * limit, page * limit), page, limit, totalItems: shown.length, totalPages: Math.max(1, Math.ceil(shown.length / limit)), truncated: false });
});
