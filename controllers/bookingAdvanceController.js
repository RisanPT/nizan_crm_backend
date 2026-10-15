import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import BankAccount from '../models/BankAccount.js';
import AccountingSetting from '../models/AccountingSetting.js';
import { applyMoneyAccount } from '../utils/moneyAccount.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';
import { ensureInvoiceNumber } from '../utils/invoiceNumber.js';

// Same audience that verifies collections.
const VERIFY_ROLES = ['admin', 'accounts', 'finance_head'];
const LIST_ROLES = [...VERIFY_ROLES, 'manager'];
const ADVANCE_MODES = ['cash', 'upi', 'bank_transfer', 'other'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The Bank & Cash account new advances land in (only while it is active and
// linked to a ledger); null = advances wait for Accounts.
const defaultAdvanceAccount = async () => {
  const setting = await AccountingSetting.findOne({}).select('advanceMoneyAccount').lean();
  if (!setting?.advanceMoneyAccount) return null;
  const acc = await BankAccount.findById(setting.advanceMoneyAccount).select('name active ledger').lean();
  return acc && acc.active !== false && acc.ledger ? acc : null;
};

// @route GET /api/booking-advances/settings
export const getAdvanceSettings = async (req, res) => {
  if (!LIST_ROLES.includes(req.user?.role)) return res.status(403).json({ message: 'No access to advances' });
  try {
    const setting = await AccountingSetting.findOne({}).select('advanceMoneyAccount').lean();
    const acc = setting?.advanceMoneyAccount
      ? await BankAccount.findById(setting.advanceMoneyAccount).select('name kind ledger active').lean()
      : null;
    res.json({
      advanceMoneyAccount: acc ? { _id: acc._id, name: acc.name, kind: acc.kind || 'bank', linked: !!acc.ledger } : null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/booking-advances/settings  { advanceMoneyAccount: id | null }
// Applies to advances on bookings saved from now on; earlier ones are unchanged.
export const updateAdvanceSettings = async (req, res) => {
  if (!VERIFY_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ message: 'Only Accounts can change this' });
  }
  try {
    const id = req.body.advanceMoneyAccount || null;
    if (id) {
      if (!mongoose.Types.ObjectId.isValid(String(id))) return res.status(400).json({ message: 'Invalid account' });
      const acc = await BankAccount.findById(id).select('name active ledger').lean();
      if (!acc || acc.active === false) return res.status(400).json({ message: 'Account not found' });
      if (!acc.ledger) {
        return res.status(400).json({ message: `"${acc.name}" is not linked to a ledger yet` });
      }
    }
    // $set only this field so the lock date etc. are left alone.
    await AccountingSetting.findOneAndUpdate({}, { $set: { advanceMoneyAccount: id } }, { upsert: true });
    return getAdvanceSettings(req, res);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Hook for booking create / update ─────────────────────────────────────────
// Keep a booking's advance verification in step with its advance amount, then
// (re)post the advance receipt. Called after every booking save.
//   • new advance (or one booked before tracking, once edited) → pending
//   • advance amount changed after a rejection → pending again
//   • advance removed → back to untracked
// A verified advance stays verified; its receipt is re-posted at the new amount.
export const syncBookingAdvance = async (booking, previousAdvance, userId = null) => {
  if (!booking?._id) return;
  const amount = round2(booking.advanceAmount);
  const changed = previousAdvance === undefined || round2(previousAdvance) !== amount;
  let status = booking.advanceStatus || '';
  if (amount <= 0) status = '';
  else if (status === '' && changed) status = 'pending';
  else if (status === 'rejected' && changed) status = 'pending';
  const set = {};
  if (status !== (booking.advanceStatus || '')) set.advanceStatus = status;
  // Sales confirm an advance before converting the lead, so when Accounts has
  // chosen where advances land, a pending one is recorded there right away.
  if (status === 'pending') {
    const target = await defaultAdvanceAccount();
    if (target) {
      status = 'verified';
      Object.assign(set, {
        advanceStatus: 'verified',
        advanceMoneyAccount: target._id,
        advanceLedgerAccount: target.ledger,
        advanceVerifiedBy: userId || null,
        advanceVerifiedAt: new Date(),
      });
    }
  }
  if (Object.keys(set).length) {
    await Booking.updateOne({ _id: booking._id }, { $set: set });
  }
  const fresh = typeof booking.toObject === 'function' ? booking.toObject() : { ...booking };
  Object.assign(fresh, set, { advanceStatus: status });
  if (typeof booking.set === 'function') booking.set(set);
  await safePost(() => postDoc('BookingAdvance', fresh, userId));
  // Runs after every booking create / update, so a price, discount or advance
  // edit that settles the balance issues the invoice number here.
  const invoiceNumber = await ensureInvoiceNumber(booking._id);
  if (invoiceNumber && !booking.invoiceNumber && typeof booking.set === 'function') {
    booking.set({ invoiceNumber });
  }
};

// Remove the advance receipt when a booking is deleted.
export const unpostBookingAdvance = (bookingId) => safePost(() => unpostDoc('BookingAdvance', bookingId));

// @route GET /api/booking-advances?status=pending|verified|rejected|untracked&from&to&search
export const getBookingAdvances = async (req, res) => {
  if (!LIST_ROLES.includes(req.user?.role)) return res.status(403).json({ message: 'No access to advances' });
  try {
    const status = ['pending', 'verified', 'rejected', 'untracked'].includes(req.query.status)
      ? req.query.status
      : 'pending';
    // Bookings saved before this existed have no advanceStatus at all (null).
    const q = { advanceAmount: { $gt: 0 }, advanceStatus: status === 'untracked' ? { $in: ['', null] } : status };
    if (req.query.from || req.query.to) {
      q.createdAt = {};
      if (req.query.from) q.createdAt.$gte = new Date(`${req.query.from}T00:00:00.000+05:30`);
      if (req.query.to) q.createdAt.$lte = new Date(`${req.query.to}T23:59:59.999+05:30`);
    }
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ customerName: rx }, { bookingNumber: rx }, { phone: rx }];
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const rows = await Booking.find(q)
      .select(
        'bookingNumber customerName phone advanceAmount totalPrice createdAt createdByName status ' +
          'advanceStatus advanceMode advancePaymentRef advanceMoneyAccount advanceVerifiedAt'
      )
      .populate('advanceMoneyAccount', 'name kind')
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    // Totals over every match, not just this page.
    const [agg] = await Booking.aggregate([
      { $match: q },
      { $group: { _id: null, total: { $sum: '$advanceAmount' }, count: { $sum: 1 } } },
    ]);
    const count = agg?.count || 0;
    res.json({
      rows,
      total: round2(agg?.total),
      count,
      page,
      limit,
      pages: Math.max(1, Math.ceil(count / limit)),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/booking-advances/:id/verify
// Body: { status: 'verified'|'rejected'|'pending', moneyAccountId, paymentMode, paymentRef }
export const verifyBookingAdvance = async (req, res) => {
  if (!VERIFY_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ message: 'Not authorized to verify advances' });
  }
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid booking' });
    const booking = await Booking.findById(req.params.id).lean();
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!(booking.advanceAmount > 0)) return res.status(400).json({ message: 'This booking has no advance' });

    const status = req.body.status;
    if (!['verified', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const set = {
      advanceStatus: status,
      advanceVerifiedBy: status === 'pending' ? null : req.user?._id || null,
      advanceVerifiedAt: status === 'pending' ? null : new Date(),
    };
    if (status === 'verified') {
      // Same rule as every approval popup: a linked Bank & Cash account.
      if (!req.body.moneyAccountId) {
        return res.status(400).json({ message: 'Choose the bank / cash account the advance landed in' });
      }
      const tmp = { paymentMode: booking.advanceMode || '' };
      const err = await applyMoneyAccount(tmp, req.body, { modeField: 'paymentMode', modes: ADVANCE_MODES });
      if (err) return res.status(400).json({ message: err });
      Object.assign(set, {
        advanceMoneyAccount: tmp.moneyAccount,
        advanceLedgerAccount: tmp.ledgerAccount,
        advancePaymentRef: tmp.paymentRef || '',
        advanceMode: tmp.paymentMode || '',
      });
    }
    // updateOne: verification must not run the booking's own save hooks.
    await Booking.updateOne({ _id: booking._id }, { $set: set });
    const fresh = await Booking.findById(booking._id).lean();
    await safePost(() => postDoc('BookingAdvance', fresh, req.user?._id || null));
    await ensureInvoiceNumber(booking._id);
    const out = await Booking.findById(booking._id)
      .select('bookingNumber customerName advanceAmount createdAt advanceStatus advanceMode advancePaymentRef advanceMoneyAccount advanceVerifiedAt')
      .populate('advanceMoneyAccount', 'name kind')
      .lean();
    res.json(out);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
